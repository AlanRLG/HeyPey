// El webhook se ata al QR guardado. La referencia del cuerpo es opcional:
// si viene y no es la orden, se rechaza; si no viene, la confirma GET /transaction/{id}.
export interface WebhookTarget {
  chargeId: string;
  reference: string;
  amountCents: number;
  transactionId?: string | null;
}

export interface StoredOrder {
  id: string;
  amount_cents: number;
  provider: string | null;
  provider_charge_id: string | null;
}

export type WebhookGate =
  | { ok: true; orderId: string }
  | { ok: false; reason: "unknown_qr" | "ref_mismatch" | "amount_mismatch" | "missing_transaction" };

export function acceptWebhookTarget(
  providerName: string,
  event: WebhookTarget,
  order: StoredOrder | null,
): WebhookGate {
  if (!order || order.provider !== providerName || order.provider_charge_id !== event.chargeId) {
    return { ok: false, reason: order ? "ref_mismatch" : "unknown_qr" };
  }
  if (event.reference && event.reference !== order.id) return { ok: false, reason: "ref_mismatch" };
  if (event.amountCents !== order.amount_cents) return { ok: false, reason: "amount_mismatch" };
  if (!event.transactionId) return { ok: false, reason: "missing_transaction" };
  return { ok: true, orderId: order.id };
}
