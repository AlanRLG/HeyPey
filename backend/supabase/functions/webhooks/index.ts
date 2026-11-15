// webhooks — POST /webhooks/<provider>. Sin JWT (verify_jwt=false): la autenticación es la firma.
// El evento y el cambio de estado se confirman juntos en mark_order_paid. Si getPayment no
// confirma ese transactionId, el evento no queda consumido y la orden pasa a PENDING_UNKNOWN.
import { audit, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import type { OrderRow } from "../_shared/orders.ts";
import { getProvider } from "../_shared/providers/index.ts";
import { confirmedReconcilePayment } from "../_shared/reconcile_payment.ts";
import type { VerifiedPayment } from "../_shared/providers/types.ts";

interface PaidResult {
  outcome: string;
  duplicate?: boolean;
  announced?: boolean;
  state?: string;
  latePayment?: boolean;
  orderId?: string | null;
}

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

  if (event.status !== "settled") {
    await audit(null, "provider_event", { provider: providerName, status: event.status, eventId: event.eventId });
    return json(req, { ok: true, ignored: event.status });
  }

  const db = serviceClient();
  const { data: orderData } = await db.from("orders").select("id, amount_cents, provider, provider_charge_id")
    .eq("provider_charge_id", event.chargeId).maybeSingle();
  const order = orderData as Pick<OrderRow, "id" | "amount_cents" | "provider" | "provider_charge_id"> | null;
  if (!order || order.id !== event.reference || order.provider !== providerName) {
    await audit(order?.id ?? null, "ref_mismatch", { chargeId: event.chargeId, reference: event.reference, eventId: event.eventId });
    return json(req, { ok: false, reason: "ref_mismatch" });
  }
  if (event.amountCents !== order.amount_cents) {
    await audit(order.id, "amount_mismatch", { expected: order.amount_cents, received: event.amountCents, eventId: event.eventId });
    return json(req, { ok: false, reason: "amount_mismatch" });
  }

  if (!event.transactionId) {
    await flagPendingUnknown(providerName, event.chargeId, event.reference, event.eventId, "missing_transaction");
    return json(req, { ok: false, reason: "pending_unknown" });
  }
  let payment: VerifiedPayment | null | undefined;
  try {
    payment = await provider.getPayment(event.chargeId, {
      transactionId: event.transactionId,
      orderId: order.id,
      amountCents: order.amount_cents,
    });
  } catch { payment = undefined; }
  if (payment === undefined) {
    await flagPendingUnknown(providerName, event.chargeId, event.reference, event.eventId, null);
    return json(req, { ok: false, reason: "pending_unknown" });
  }
  const decision = confirmedReconcilePayment(order, payment, event.transactionId);
  if (!decision.pay || !decision.transactionId || decision.amountCents == null || !decision.chargeId) {
    await audit(order.id, decision.reason, { via: "webhook", eventId: event.eventId, received: decision.amountCents ?? null, transactionId: event.transactionId });
    const mismatch = decision.reason === "amount_mismatch" || decision.reason === "qr_mismatch"
      || decision.reason === "reference_mismatch" || decision.reason === "transaction_mismatch";
    if (!mismatch && payment === null) {
      await flagPendingUnknown(providerName, event.chargeId, event.reference, event.eventId, "open");
    }
    return json(req, { ok: false, reason: mismatch ? decision.reason : "pending_unknown" });
  }

  const { data, error } = await db.rpc("mark_order_paid", {
    p_provider: providerName,
    p_event_id: event.eventId,
    p_charge_id: decision.chargeId,
    p_order_id: event.reference,
    p_amount_cents: decision.amountCents,
    p_transaction_id: decision.transactionId,
    p_tracking_key: decision.trackingKey ?? event.trackingKey ?? null,
    p_payload: event.raw ?? {},
  });
  if (error) throw new Error(error.message);
  return json(req, webhookBody(data as PaidResult));
});

function webhookBody(result: PaidResult): Record<string, unknown> {
  if (result.duplicate || result.outcome === "duplicate" || result.outcome === "duplicate_transaction") {
    return { ok: true, duplicate: true, state: result.state ?? null, latePayment: !!result.latePayment };
  }
  if (result.outcome === "paid") return { ok: true, state: "PAID", latePayment: false };
  if (result.outcome === "late_paid") return { ok: true, state: "PAID", latePayment: true };
  if (result.outcome === "amount_mismatch") return { ok: false, reason: "amount_mismatch" };
  if (result.outcome === "ref_mismatch") return { ok: false, reason: "ref_mismatch" };
  return { ok: false, reason: result.outcome ?? "rejected" };
}

async function flagPendingUnknown(
  providerName: string,
  chargeId: string,
  reference: string,
  eventId: string,
  status: string | null,
): Promise<void> {
  const db = serviceClient();
  const { data } = await db.from("orders").select("id, state, provider").eq("provider_charge_id", chargeId).maybeSingle();
  const order = data as Pick<OrderRow, "id" | "state" | "provider"> | null;
  if (!order || order.id !== reference || order.provider !== providerName) {
    await audit(order?.id ?? null, "ref_mismatch", { chargeId, reference, eventId, getStatus: status });
    return;
  }
  const now = new Date().toISOString();
  const { data: upd } = await db.from("orders").update({
    state: "PENDING_UNKNOWN",
    next_reconcile_at: now,
  }).eq("id", order.id).eq("state", "AWAITING_PAYMENT").select("id");
  await audit(order.id, "status_mismatch", {
    webhook: "settled",
    getStatus: status,
    eventId,
    changed: !!upd?.length,
  });
}
