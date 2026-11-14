#!/usr/bin/env bash
# Crea (o reutiliza) la cuenta de demo, su comerciante, el puesto con provider='mock' y el catálogo.
# Funciona contra Supabase local o en la nube. Imprime el STALL_ID.
#
#   SUPABASE_URL=https://<ref>.supabase.co SERVICE_ROLE_KEY=... \
#   DEMO_EMAIL=demo@copiloto.invalid DEMO_PASSWORD=... tools/deploy/bootstrap_demo.sh
#
# La service_role solo se usa aquí, en tu terminal. Nunca la pongas en archivos servidos.
set -euo pipefail
: "${SUPABASE_URL:?}" "${SERVICE_ROLE_KEY:?}" "${DEMO_EMAIL:?}" "${DEMO_PASSWORD:?}"

H=(-H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json")
REST="$SUPABASE_URL/rest/v1"

user_id=$(curl -s "${H[@]}" -X POST "$SUPABASE_URL/auth/v1/admin/users" \
  -d "$(jq -n --arg e "$DEMO_EMAIL" --arg p "$DEMO_PASSWORD" '{email:$e,password:$p,email_confirm:true}')" | jq -r '.id // empty')
if [[ -z "$user_id" ]]; then
  user_id=$(curl -s "${H[@]}" "$SUPABASE_URL/auth/v1/admin/users?per_page=1000" \
    | jq -r --arg e "$DEMO_EMAIL" '.users[] | select(.email==$e) | .id' | head -1)
  # Asegura que la contraseña coincida con la de config.js
  curl -s "${H[@]}" -X PUT "$SUPABASE_URL/auth/v1/admin/users/$user_id" \
    -d "$(jq -n --arg p "$DEMO_PASSWORD" '{password:$p}')" > /dev/null
fi
[[ -n "$user_id" ]] || { echo "No se pudo crear ni encontrar el usuario demo" >&2; exit 1; }

merchant_id=$(curl -s "${H[@]}" -H "Prefer: resolution=merge-duplicates,return=representation" \
  -X POST "$REST/merchants?on_conflict=user_id" \
  -d "$(jq -n --arg u "$user_id" '{user_id:$u, display_name:"Doña Carmen (demo)"}')" | jq -r '.[0].id')

stall_id=$(curl -s "${H[@]}" "$REST/stalls?merchant_id=eq.$merchant_id&select=id&limit=1" | jq -r '.[0].id // empty')
if [[ -z "$stall_id" ]]; then
  stall_id=$(curl -s "${H[@]}" -H "Prefer: return=representation" -X POST "$REST/stalls" \
    -d "$(jq -n --arg m "$merchant_id" '{merchant_id:$m, name:"Pollería Doña Carmen", market:"Mercado de prueba", provider:"mock", public_announce:true}')" \
    | jq -r '.[0].id')
fi

curl -s "${H[@]}" -H "Prefer: resolution=ignore-duplicates" -X POST "$REST/catalog_items?on_conflict=stall_id,name" \
  -d "$(jq -n --arg s "$stall_id" '[
    {stall_id:$s, name:"pechuga",   aliases:["pollo"],  unit:"kg", price_cents:14000},
    {stall_id:$s, name:"diezmillo", aliases:[],         unit:"kg", price_cents:24000},
    {stall_id:$s, name:"chorizo",   aliases:[],         unit:"kg", price_cents:16000},
    {stall_id:$s, name:"jitomate",  aliases:["tomate"], unit:"kg", price_cents:3500}]')" > /dev/null

echo "USER_ID=$user_id"
echo "MERCHANT_ID=$merchant_id"
echo "STALL_ID=$stall_id"
