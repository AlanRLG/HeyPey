// webhooks — POST /webhooks/<provider>. Sin JWT (verify_jwt=false): la autenticación es la firma.
// El evento y el cambio de estado se confirman juntos en mark_order_paid. Si getPayment no
// confirma ese transactionId, el evento no queda consumido y la orden pasa a PENDING_UNKNOWN.
import { audit, serviceClient } from "../_shared/db.ts";
import { json } from "../_shared/http.ts";
import type { OrderRow } from "../_shared/orders.ts";
import { getProvider } from "../_shared/providers/index.ts";
import { redactSecrets } from "../_shared/access.ts";
import { settleWebhookPayment } from "../_shared/webhook_settle.ts";

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
  try { event = await provider.verifyWebhook(req, raw); } catch (e) {
    console.error("verifyWebhook", redactSecrets(e instanceof Error ? e.message : "error"));
    event = null;
  }
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
  const settled = await settleWebhookPayment({
    providerName,
    event,
    order,
    getPayment: (chargeId, selector) => provider.getPayment(chargeId, selector),
    payload: safePayload(event.raw),
  });
  if (settled.outcome === "gate") {
    await audit(settled.orderId, settled.reason, { chargeId: event.chargeId, reference: event.reference, eventId: event.eventId });
    if (settled.reason === "missing_transaction" && order) {
      await flagPendingUnknown(providerName, event.chargeId, order.id, event.eventId, "missing_transaction");
      return json(req, { ok: false, reason: "pending_unknown" });
    }
    return json(req, { ok: false, reason: settled.reason === "amount_mismatch" ? "amount_mismatch" : "ref_mismatch" });
  }
  if (settled.outcome === "reject") {
    await audit(settled.orderId, settled.reason, { via: "webhook", eventId: event.eventId, transactionId: event.transactionId });
    return json(req, { ok: false, reason: settled.reason });
  }
  if (settled.outcome === "pending") {
    if (settled.status && settled.status !== "open") {
      console.error("getPayment", redactSecrets(settled.status));
    }
    await flagPendingUnknown(providerName, event.chargeId, settled.orderId, event.eventId, settled.status);
    return json(req, { ok: false, reason: "pending_unknown" });
  }

  const { data, error } = await db.rpc("mark_order_paid", settled.rpc);
  if (error) throw new Error(error.message);
  return json(req, webhookBody(data as PaidResult));
});

function safePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const metadata = body.metadata;
  let safeMeta: Record<string, unknown> | undefined;
  if (metadata && typeof metadata === "object") {
    const meta = metadata as Record<string, unknown>;
    safeMeta = {};
    if (typeof meta.trackingKey === "string") safeMeta.trackingKey = meta.trackingKey;
    const external = meta.externalMetadata;
    if (external && typeof external === "object" && typeof (external as Record<string, unknown>).orderId === "string") {
      safeMeta.externalMetadata = { orderId: (external as Record<string, unknown>).orderId };
    }
  }
  return {
    type: body.type ?? null,
    transactionId: body.transactionId ?? null,
    codiQrId: body.codiQrId ?? null,
    amount: body.amount ?? null,
    metadata: safeMeta ?? null,
  };
}

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
