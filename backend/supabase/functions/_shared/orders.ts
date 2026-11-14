// Vistas de una orden. La vista de cliente jamás incluye la palabra antes de PAID.
export interface OrderRow {
  id: string;
  stall_id: string;
  number: number;
  amount_cents: number;
  method: string;
  state: string;
  secret_word: string | null;
  qr_payload: string | null;
  expires_at: string | null;
  paid_at: string | null;
  late_payment: boolean;
  items: unknown;
  provider: string | null;
  provider_charge_id: string | null;
  created_at: string;
}

export const ACTIVE_STATES = ["CREATING", "AWAITING_PAYMENT", "PENDING_UNKNOWN"];

export function merchantView(o: OrderRow) {
  return {
    orderId: o.id,
    number: o.number,
    amountCents: o.amount_cents,
    method: o.method,
    state: o.state,
    secretWord: o.secret_word,
    qrPayload: o.qr_payload,
    expiresAt: o.expires_at,
    paidAt: o.paid_at,
    latePayment: o.late_payment,
    items: o.items,
    createdAt: o.created_at,
  };
}

export function customerView(o: OrderRow) {
  return {
    orderId: o.id,
    number: o.number,
    amountCents: o.amount_cents,
    method: o.method,
    state: o.state,
    qrPayload: o.state === "AWAITING_PAYMENT" ? o.qr_payload : null,
    expiresAt: o.expires_at,
    secretWord: o.state === "PAID" ? o.secret_word : null,
  };
}
