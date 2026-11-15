#!/usr/bin/env bash
# Verificación de punta a punta con MockProvider (DEPLOY.md §9). Sin dinero real.
#   SUPABASE_URL=... ANON=... STALL_ID=... DEMO_EMAIL=... DEMO_PASSWORD=... tools/deploy/e2e_mock.sh
set -uo pipefail
: "${SUPABASE_URL:?}" "${ANON:?}" "${STALL_ID:?}" "${DEMO_EMAIL:?}" "${DEMO_PASSWORD:?}"
FN="$SUPABASE_URL/functions/v1"
pass=0; fail=0
ok()   { echo "  ✔ $1"; pass=$((pass+1)); }
bad()  { echo "  ✘ $1"; fail=$((fail+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (esperado '$3', obtenido '$2')"; fi; }

JWT=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d "$(jq -n --arg e "$DEMO_EMAIL" --arg p "$DEMO_PASSWORD" '{email:$e,password:$p}')" | jq -r .access_token)
[[ "$JWT" != "null" && -n "$JWT" ]] || { echo "login falló"; exit 1; }
A=(-H "Authorization: Bearer $JWT" -H "apikey: $ANON" -H "Content-Type: application/json")

create() { # amountCents method [idemKey]
  curl -s "${A[@]}" -X POST "$FN/orders" -d "$(jq -n --arg s "$STALL_ID" --argjson a "$1" --arg m "$2" --arg k "${3:-$(uuidgen)}" \
    '{stallId:$s, amountCents:$a, amountSource:"manual", method:$m, items:[], idempotencyKey:$k}')"; }
pay() { # orderId [extraJson]
  local x="${2:-}"; [[ -n "$x" ]] || x="{}"
  curl -s "${A[@]}" -X POST "$FN/mock-pay" -d "$(jq -n --arg o "$1" --argjson x "$x" '{orderId:$o} + $x')"; }
state() { curl -s "${A[@]}" "$FN/orders?stallId=$STALL_ID&view=merchant" | jq -r --arg o "$1" '.orders[] | select(.orderId==$o) | .state'; }
cust()  { curl -s -H "apikey: $ANON" "$FN/public-orders?stallId=$STALL_ID" | jq -c --arg o "$1" '.orders[] | select(.orderId==$o)'; }

echo "1. Cobro → pago simulado → PAID"
O1=$(create 24000 codi); ID1=$(jq -r .orderId <<<"$O1")
check "estado inicial" "$(jq -r .state <<<"$O1")" "AWAITING_PAYMENT"
[[ -n "$(jq -r '.secretWord // empty' <<<"$O1")" ]] && ok "comerciante recibe palabra" || bad "sin palabra"
check "vista cliente sin palabra antes de pagar" "$(cust "$ID1" | jq -r .secretWord)" "null"
R=$(pay "$ID1"); EVT=$(jq -r .eventId <<<"$R")
check "webhook PAID" "$(jq -r .webhook.state <<<"$R")" "PAID"
check "estado PAID" "$(state "$ID1")" "PAID"
check "vista cliente con palabra tras PAID" "$(cust "$ID1" | jq -r .secretWord)" "$(jq -r .secretWord <<<"$O1")"
check "no se cancela una orden PAID" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "$FN/orders/$ID1/cancel")" "409"

echo "2. Evento duplicado"
R=$(pay "$ID1" "{\"eventId\":\"$EVT\"}")
check "duplicado reconocido" "$(jq -r .webhook.duplicate <<<"$R")" "true"

echo "3. Firma inválida y monto distinto"
O2=$(create 15000 codi); ID2=$(jq -r .orderId <<<"$O2")
check "firma inválida → 401" "$(jq -r .webhookStatus <<<"$(pay "$ID2" '{"badSignature":true}')")" "401"
check "monto distinto rechazado" "$(jq -r .webhook.reason <<<"$(pay "$ID2" '{"amountCents":15100}')")" "amount_mismatch"
check "sigue esperando pago" "$(state "$ID2")" "AWAITING_PAYMENT"

echo "4. Dos órdenes simultáneas con palabras distintas"
O3=$(create 9000 codi); ID3=$(jq -r .orderId <<<"$O3")
[[ "$(jq -r .secretWord <<<"$O2")" != "$(jq -r .secretWord <<<"$O3")" ]] && ok "palabras distintas" || bad "palabras iguales"

echo "5. Pago después de cancelar"
check "cancelar" "$(curl -s "${A[@]}" -X POST "$FN/orders/$ID3/cancel" | jq -r .state)" "CANCELLED"
R=$(pay "$ID3")
check "pago tardío marcado" "$(jq -r .webhook.latePayment <<<"$R")" "true"
check "el dinero queda PAID" "$(state "$ID3")" "PAID"
PUB=$(cust "$ID3")
if [[ -z "$PUB" ]]; then ok "el cliente no ve el pago tardío"; else
  check "el cliente no recibe la palabra del pago tardío" "$(jq -r '.secretWord // "null"' <<<"$PUB")" "null"
fi
curl -s "${A[@]}" -X POST "$FN/orders/$ID2/cancel" > /dev/null

echo "6. Efectivo"
O4=$(create 5000 cash)
check "PAID_CASH" "$(jq -r .state <<<"$O4")" "PAID_CASH"
check "sin palabra" "$(jq -r .secretWord <<<"$O4")" "null"

echo "7. Idempotencia"
K=$(uuidgen); A1=$(create 7000 cash "$K" | jq -r .orderId); A2=$(create 7000 cash "$K" | jq -r .orderId)
check "misma orden" "$A2" "$A1"

echo "8. Monto bajo el mínimo"
check "422" "$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X POST "$FN/orders" \
  -d "{\"stallId\":\"$STALL_ID\",\"amountCents\":1,\"method\":\"codi\",\"idempotencyKey\":\"$(uuidgen)\"}")" "422"

echo "9. Seguridad de acceso"
check "orders sin JWT → 401" "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" "$FN/orders?stallId=$STALL_ID")" "401"
check "mock-pay sin JWT → 401" "$(curl -s -o /dev/null -w '%{http_code}' -H "apikey: $ANON" -X POST "$FN/mock-pay" -d "{\"orderId\":\"$ID1\"}")" "401"
check "anon no lee órdenes (RLS)" "$(curl -s -H "apikey: $ANON" "$SUPABASE_URL/rest/v1/orders?select=id" | jq length)" "0"
check "reconcile sin secreto → 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$FN/reconcile")" "401"

echo; echo "Resultado: $pass OK, $fail fallos"
[[ $fail -eq 0 ]]
