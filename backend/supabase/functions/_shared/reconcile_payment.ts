// Decide si un pago leído del proveedor puede marcar la orden. El monto y el
// identificador salen del proveedor; no se inventan a partir de la orden.
import type { VerifiedPayment } from "./providers/types.ts";

export interface PayableOrder {
  id: string;
  amount_cents: number;
  provider_charge_id: string | null;
}

export interface ReconcilePaymentDecision {
  pay: boolean;
  reason: "ok" | "unconfirmed" | "amount_mismatch" | "qr_mismatch" | "reference_mismatch" | "missing_transaction" | "transaction_mismatch";
  amountCents?: number;
  transactionId?: string;
  chargeId?: string;
  trackingKey?: string | null;
  eventId?: string;
}

/** Entre varios pagos del mismo QR, uno que pertenece a esta orden. No el primero de la lista. */
export function selectPaymentForOrder(order: PayableOrder, payments: VerifiedPayment[]): VerifiedPayment | null {
  const sameOrder = payments.filter((payment) =>
    payment.chargeId === order.provider_charge_id && payment.reference === order.id && payment.transactionId
  );
  return sameOrder.find((payment) => payment.amountCents === order.amount_cents) ?? sameOrder[0] ?? null;
}

export function confirmedReconcilePayment(
  order: PayableOrder,
  payment: VerifiedPayment | null,
  expectedTransactionId?: string | null,
): ReconcilePaymentDecision {
  if (!payment) return { pay: false, reason: "unconfirmed" };
  if (!payment.transactionId) return { pay: false, reason: "missing_transaction" };
  if (expectedTransactionId && payment.transactionId !== expectedTransactionId) {
    return { pay: false, reason: "transaction_mismatch", transactionId: payment.transactionId, amountCents: payment.amountCents };
  }
  if (!order.provider_charge_id || payment.chargeId !== order.provider_charge_id) {
    return { pay: false, reason: "qr_mismatch" };
  }
  if (payment.reference !== order.id) {
    return { pay: false, reason: "reference_mismatch" };
  }
  if (payment.amountCents !== order.amount_cents) {
    return { pay: false, reason: "amount_mismatch", amountCents: payment.amountCents };
  }
  return {
    pay: true,
    reason: "ok",
    amountCents: payment.amountCents,
    transactionId: payment.transactionId,
    chargeId: payment.chargeId,
    trackingKey: payment.trackingKey,
    eventId: `reconcile:${payment.transactionId}`,
  };
}
