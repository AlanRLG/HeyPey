// mock-pay — SOLO DEMO. Simula que el banco liquidó una carga del MockProvider y envía el
// webhook firmado a /webhooks/mock. El estado PAID lo decide igualmente el webhook (servidor).
// Protecciones: ENABLE_MOCK_PAY, JWT del dueño y provider = 'mock'.
import { mockPayAllowed } from "../_shared/access.ts";
import { requireUser, ownedStall } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { signMockPayload } from "../_shared/providers/mock.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (Deno.env.get("ENABLE_MOCK_PAY") !== "true") return new Response("Not found", { status: 404 });
  if (req.method !== "POST") return json(req, { error: "method" }, 405);

  const caller = await requireUser(req);
  if (!caller) return json(req, { error: "unauthorized" }, 401);

  const body = await req.json().catch(() => null);
  if (!body) return json(req, { error: "invalid_json" }, 400);
  const db = serviceClient();

  // Acepta chargeId u orderId (el simulador solo conoce orderId).
  let q = db.from("orders").select("id, stall_id, amount_cents, provider, provider_charge_id");
  q = body.chargeId ? q.eq("provider_charge_id", String(body.chargeId)) : q.eq("id", String(body.orderId ?? ""));
  const { data: order } = await q.maybeSingle();
  if (!order || !order.provider_charge_id) return json(req, { error: "not_found" }, 404);

  const stall = await ownedStall(caller.userId, order.stall_id);
  if (!stall) return json(req, { error: "not_found" }, 404);
  if (!mockPayAllowed(String(order.provider), stall.provider)) return json(req, { error: "solo_mock" }, 403);

  // Variantes de prueba (sección 9 de DEPLOY.md).
  const eventId = typeof body.eventId === "string" && body.eventId ? body.eventId : `evt_${crypto.randomUUID()}`;
  const amountCents = Number.isInteger(body.amountCents) ? body.amountCents : order.amount_cents;
  const badSignature = body.badSignature === true;
  const newTrackingKey = `MOCK${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;

  // El "banco" liquida la carga si el monto coincide. El identificador queda en la carga
  // para que la conciliación lo lea y no tenga que inventarlo.
  if (!badSignature && amountCents === order.amount_cents) {
    const { error } = await db.from("mock_charges").update({
      status: "settled",
      transaction_id: newTrackingKey,
      tracking_key: newTrackingKey,
    }).eq("charge_id", order.provider_charge_id).in("status", ["pending", "cancelled", "expired"]);
    if (error) return json(req, { error: "mock_settlement_failed" }, 500);
  }

  // Un webhook repetido debe describir el mismo pago. Lee el identificador que
  // quedó guardado, incluso si otra solicitud liquidó la carga al mismo tiempo.
  const { data: charge, error: chargeError } = await db.from("mock_charges")
    .select("transaction_id, tracking_key").eq("charge_id", order.provider_charge_id).maybeSingle();
  if (chargeError || !charge) return json(req, { error: "mock_charge_not_found" }, 500);
  const trackingKey = charge.transaction_id || charge.tracking_key || newTrackingKey;

  const payload = JSON.stringify({
    eventId,
    chargeId: order.provider_charge_id,
    reference: order.id,
    amountCents,
    status: "settled",
    trackingKey,
    transactionId: trackingKey,
    simulated: true,
  });
  const signature = badSignature ? "t=0,v1=deadbeef" : await signMockPayload(payload);

  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/webhooks/mock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-mock-signature": signature },
    body: payload,
  });
  const webhook = await res.json().catch(() => null);
  return json(req, { simulated: true, eventId, webhookStatus: res.status, webhook });
});
