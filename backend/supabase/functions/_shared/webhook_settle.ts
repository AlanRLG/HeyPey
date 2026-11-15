// Del evento firmado a los argumentos de mark_order_paid. La orden es la que
// identificó el QR guardado, no la referencia del cuerpo, que puede venir vacía.
import { PeyPaymentRejected, PeyUnavailable } from "./providers/pey.ts";
import type { PaymentSelector, VerifiedPayment, WebhookEvent } from "./providers/types.ts";
import { confirmedReconcilePayment } from "./reconcile_payment.ts";
import { acceptWebhookTarget, type StoredOrder } from "./webhook_gate.ts";

export interface PaidRpcArgs {
  p_provider: string;
  p_event_id: string;
  p_charge_id: string;
  p_order_id: string;
  p_amount_cents: number;
  p_transaction_id: string;
  p_tracking_key: string | null;
  p_payload: unknown;
}

export type SettleWebhookResult =
  | { outcome: "pay"; rpc: PaidRpcArgs }
  | { outcome: "gate"; reason: "unknown_qr" | "ref_mismatch" | "amount_mismatch" | "missing_transaction"; orderId: string | null }
  | { outcome: "reject"; reason: string; orderId: string }
  | { outcome: "pending"; orderId: string; status: string | null };

export async function settleWebhookPayment(input: {
  providerName: string;
  event: WebhookEvent;
  order: StoredOrder | null;
  getPayment: (chargeId: string, selector?: PaymentSelector) => Promise<VerifiedPayment | null>;
  payload: unknown;
}): Promise<SettleWebhookResult> {
  const gate = acceptWebhookTarget(input.providerName, {
    chargeId: input.event.chargeId,
    reference: input.event.reference,
    amountCents: input.event.amountCents,
    transactionId: input.event.transactionId,
  }, input.order);
  if (!gate.ok) return { outcome: "gate", reason: gate.reason, orderId: input.order?.id ?? null };

  let payment: VerifiedPayment | null;
  try {
    payment = await input.getPayment(input.event.chargeId, {
      transactionId: input.event.transactionId,
      orderId: gate.orderId,
      amountCents: input.order!.amount_cents,
    });
  } catch (error) {
    if (error instanceof PeyPaymentRejected || (error instanceof Error && error.name === "PeyPaymentRejected")) {
      const reason = error instanceof PeyPaymentRejected ? error.reason : error.message;
      return { outcome: "reject", reason, orderId: gate.orderId };
    }
    return {
      outcome: "pending",
      orderId: gate.orderId,
      status: error instanceof PeyUnavailable ? error.message : null,
    };
  }

  const decision = confirmedReconcilePayment(input.order, payment, input.event.transactionId);
  if (!decision.pay || !decision.transactionId || decision.amountCents == null || !decision.chargeId) {
    const mismatch = decision.reason === "amount_mismatch" || decision.reason === "qr_mismatch"
      || decision.reason === "reference_mismatch" || decision.reason === "transaction_mismatch";
    if (mismatch) return { outcome: "reject", reason: decision.reason, orderId: gate.orderId };
    return { outcome: "pending", orderId: gate.orderId, status: payment === null ? "open" : null };
  }

  return {
    outcome: "pay",
    rpc: {
      p_provider: input.providerName,
      p_event_id: input.event.eventId,
      p_charge_id: decision.chargeId,
      p_order_id: gate.orderId,
      p_amount_cents: decision.amountCents,
      p_transaction_id: decision.transactionId,
      p_tracking_key: decision.trackingKey ?? input.event.trackingKey ?? null,
      p_payload: input.payload,
    },
  };
}
