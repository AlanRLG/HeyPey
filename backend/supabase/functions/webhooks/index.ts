// webhooks — POST /webhooks/<provider>. Sin JWT (verify_jwt=false): la autenticación es la firma.
// Orden de validación: firma → idempotencia (payment_events) → referencia → monto → getStatus.
import { audit, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import { getProvider } from "../_shared/providers/index.ts";
import type { OrderRow } from "../_shared/orders.ts";

const PAYABLE = ["AWAITING_PAYMENT", "PENDING_UNKNOWN"];

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, { error: "method" }, 405);
  const providerName = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

  let provider;
  try { provider = getProvider(providerName); } catch { return json(req, { error: "provider" }, 404); }

  const raw = await req.text();
  let event;
  try { event = await provider.verifyWebhook(req, raw); } catch (e) { console.error(e); event = null; }
  if (!event) {
    await audit(null, "invalid_signature", { provider: providerName });
    return json(req, { error: "invalid_signature" }, 401);
  }

  const db = serviceClient();

  // Idempotencia: un evento repetido se reconoce (200) pero no vuelve a procesarse ni anunciarse.
  const { data: inserted, error: insErr } = await db.from("payment_events")
    .upsert({ provider: providerName, event_id: event.eventId, charge_id: event.chargeId, payload: event.raw },
      { onConflict: "provider,event_id", ignoreDuplicates: true })
    .select("id");
  if (insErr) throw new Error(insErr.message);
  if (!inserted?.length) return json(req, { ok: true, duplicate: true });

  const { data: orderData } = await db.from("orders").select("*").eq("provider_charge_id", event.chargeId).maybeSingle();
  const order = orderData as OrderRow | null;
  if (!order || order.id !== event.reference || order.provider !== providerName) {
    await audit(order?.id ?? null, "ref_mismatch", { chargeId: event.chargeId, reference: event.reference, eventId: event.eventId });
    return json(req, { ok: false, reason: "ref_mismatch" });
  }
  await db.from("payment_events").update({ order_id: order.id }).eq("provider", providerName).eq("event_id", event.eventId);

  if (event.amountCents !== order.amount_cents) {
    await audit(order.id, "amount_mismatch", { expected: order.amount_cents, received: event.amountCents, eventId: event.eventId });
    return json(req, { ok: false, reason: "amount_mismatch" });
  }
  if (event.status !== "settled") {
    await audit(order.id, "provider_event", { status: event.status, eventId: event.eventId });
    return json(req, { ok: true, ignored: event.status });
  }

  // Doble verificación: consulta independiente al proveedor.
  const status = await provider.getStatus(event.chargeId).catch(() => null);
  if (status !== "settled") {
    const { data: upd } = await db.from("orders").update({ state: "PENDING_UNKNOWN" })
      .eq("id", order.id).eq("state", "AWAITING_PAYMENT").select("id");
    await audit(order.id, "status_mismatch", { webhook: event.status, getStatus: status, changed: !!upd?.length });
    return json(req, { ok: false, reason: "pending_unknown" });
  }

  const { data: paid } = await db.from("orders")
    .update({ state: "PAID", paid_at: new Date().toISOString() })
    .eq("id", order.id).in("state", PAYABLE).select("id");

  if (paid?.length) {
    await audit(order.id, "state_change", { from: order.state, to: "PAID", eventId: event.eventId, trackingKey: event.trackingKey });
    return json(req, { ok: true, state: "PAID" });
  }

  // Pago que llega después de cancelar o expirar: bandera y aviso privado al comerciante.
  if (["CANCELLED", "EXPIRED"].includes(order.state)) {
    await db.from("orders").update({ late_payment: true }).eq("id", order.id);
    await audit(order.id, "late_payment", { state: order.state, eventId: event.eventId });
    return json(req, { ok: true, latePayment: true });
  }
  return json(req, { ok: true, state: order.state });
});
