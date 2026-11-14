// mock-pay — SOLO DEMO. Simula que el banco liquidó una carga del MockProvider y envía el
// webhook firmado a /webhooks/mock. El estado PAID lo decide igualmente el webhook (servidor).
// Protecciones (brecha B4): ENABLE_MOCK_PAY, x-mock-pay-token, JWT del dueño y provider = 'mock'.
import { requireUser, ownedStall } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { signMockPayload } from "../_shared/providers/mock.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (Deno.env.get("ENABLE_MOCK_PAY") !== "true") return new Response("Not found", { status: 404 });
  if (req.method !== "POST") return json(req, { error: "method" }, 405);

  const token = Deno.env.get("MOCK_PAY_TOKEN");
  if (!token || req.headers.get("x-mock-pay-token") !== token) return json(req, { error: "forbidden" }, 403);

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
  if (stall.provider !== "mock" || order.provider !== "mock") return json(req, { error: "solo_mock" }, 403);

  // Variantes de prueba (sección 9 de DEPLOY.md).
  const eventId = typeof body.eventId === "string" && body.eventId ? body.eventId : `evt_${crypto.randomUUID()}`;
  const amountCents = Number.isInteger(body.amountCents) ? body.amountCents : order.amount_cents;
  const badSignature = body.badSignature === true;

  // El "banco" liquida la carga si el monto coincide. Puede ocurrir aunque el puesto ya la haya
  // cancelado o haya expirado (así se prueba el pago tardío, que el servidor marca como late_payment).
  if (!badSignature && amountCents === order.amount_cents) {
    await db.from("mock_charges").update({ status: "settled" }).eq("charge_id", order.provider_charge_id)
      .in("status", ["pending", "cancelled", "expired"]);
  }

  const payload = JSON.stringify({
    eventId,
    chargeId: order.provider_charge_id,
    reference: order.id,
    amountCents,
    status: "settled",
    trackingKey: `MOCK${Date.now()}`,
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
