#!/usr/bin/env bash
# Despliegue Nivel 1 a Supabase en la nube (DEPLOY.md §4) y configuración del simulador (§6).
# Requisitos: `supabase login` hecho, proyecto creado, psql (brew install libpq) y jq.
#
#   PROJECT_REF=<ref> DB_PASSWORD='<contraseña de la BD>' tools/deploy/deploy_cloud.sh
#
# RESUME_FROM=cron salta enlace, migraciones, secretos y funciones (ya desplegados) y retoma
# pg_cron y config.js. La cuenta demo se crea por separado con bootstrap_demo.sh.
#
# Genera backend/.env.secrets (no versionado) si no existe, y reescribe tools/simulator/config.js
# solo con valores públicos (URL, anon key y puesto). STALL_ID se pasa como variable de entorno.
set -euo pipefail
: "${PROJECT_REF:?}" "${DB_PASSWORD:?}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL="$(command -v psql || echo /opt/homebrew/opt/libpq/bin/psql)"
URL="https://$PROJECT_REF.supabase.co"
cd "$ROOT/backend"

if [[ "${RESUME_FROM:-}" != "cron" ]]; then
echo "==> Enlazando proyecto"
supabase link "$PROJECT_REF"

echo "==> Migraciones"
supabase db push --remote --password "$DB_PASSWORD" --yes

if [[ ! -f .env.secrets ]]; then
  echo "==> Generando backend/.env.secrets"
  cat > .env.secrets <<SECRETS
MOCK_WEBHOOK_SECRET=$(openssl rand -hex 32)
ENABLE_MOCK_PAY=true
CRON_SECRET=$(openssl rand -hex 32)
MIN_AMOUNT_CENTS=500
ORDER_TTL_SECONDS=180
ALLOWED_ORIGINS=https://copiloto-zeroui.vercel.app,http://localhost:3000
SECRETS
  chmod 600 .env.secrets
fi
set -a; source .env.secrets; set +a

echo "==> Secretos de funciones"
grep -v -E '^(DEMO_PASSWORD|MOCK_PAY_TOKEN)=' .env.secrets > .env.secrets.functions
supabase secrets set --env-file .env.secrets.functions --remote --yes
rm -f .env.secrets.functions

echo "==> Edge Functions"
for f in orders webhooks reconcile mock-pay public-orders; do
  supabase functions deploy "$f" --remote --use-api --yes
done

fi
[[ -f .env.secrets ]] || { echo "Falta backend/.env.secrets" >&2; exit 1; }
set -a; source .env.secrets; set +a

echo "==> Claves del proyecto"
KEYS=$(supabase projects api-keys --remote --reveal -o json 2>/dev/null)
ANON=$(jq -r '[.. | objects | select(.name=="anon")][0].api_key' <<<"$KEYS")

echo "==> pg_cron (reconcile cada minuto)"
# El host directo db.<ref>.supabase.co solo tiene IPv6; se usa el pooler (IPv4, modo sesión)
# que `supabase link` guarda en supabase/.temp/pooler-url.
POOLER=$(cat supabase/.temp/pooler-url 2>/dev/null || true)
[[ -n "$POOLER" ]] || POOLER="postgresql://postgres.${PROJECT_REF}@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
export PGPASSWORD="$DB_PASSWORD"
DBURL=$(sed -E 's#://([^:@/]+)(:[^@]*)?@#://\1@#' <<<"$POOLER")
"$PSQL" "$DBURL" -v ON_ERROR_STOP=1 -v cron_secret="$CRON_SECRET" -v fn_url="$URL/functions/v1/reconcile" <<'SQL'
create extension if not exists pg_cron;
create extension if not exists pg_net;
select vault.create_secret(:'cron_secret', 'cron_secret')
  where not exists (select 1 from vault.secrets where name = 'cron_secret');
select vault.update_secret((select id from vault.secrets where name = 'cron_secret'), :'cron_secret');
select cron.unschedule('reconcile-orders') where exists (select 1 from cron.job where jobname = 'reconcile-orders');
select cron.schedule('reconcile-orders', '* * * * *', format($cron$
  select net.http_post(
    url := %L,
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb);
$cron$, :'fn_url'));
SQL

echo "==> tools/simulator/config.js"
cat > "$ROOT/tools/simulator/config.js" <<JS
// Configuración pública del simulador (generada por tools/deploy/deploy_cloud.sh).
// La anon key es pública por diseño (la protege RLS). NUNCA pongas aquí la service_role.
// Solo datos públicos. La cuenta del comerciante inicia sesión manualmente.
window.COPILOTO_CONFIG = {
  SUPABASE_URL: "$URL",
  SUPABASE_ANON_KEY: "$ANON",
  STALL_ID: "${STALL_ID:-}",
};
JS

echo "==> Verificación de punta a punta: ejecutar e2e_mock.sh tras crear la cuenta y el puesto demo"
