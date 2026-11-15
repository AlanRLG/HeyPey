// Contrato común de proveedores de pago. La app nunca decide un pago: solo el servidor,
// con un evento firmado y getPayment (el transactionId del webhook, o un pago de esa orden).

export type ChargeStatus = "pending" | "settled" | "expired" | "failed" | "cancelled";

export interface CreateChargeInput {
  orderId: string;
  amountCents: number;
  expiresAt: string;
  accountRef: string | null;
  concept?: string;
}

export interface CreateChargeResult {
  chargeId: string;
  qrPayload: string;
  /** Vencimiento efectivo. pey puede alargarlo hasta el mínimo de 360 s. */
  expiresAt: string;
}

/** Pago leído del proveedor, no reconstruido a partir de la orden. */
export interface VerifiedPayment {
  chargeId: string;
  transactionId: string;
  amountCents: number;
  trackingKey: string | null;
  reference: string | null;
}

export interface WebhookEvent {
  eventId: string;
  chargeId: string;
  reference: string; // debe mapear a orders.id
  amountCents: number;
  status: ChargeStatus;
  trackingKey?: string | null;
  transactionId?: string | null;
  raw: unknown;
}

/** Qué pago buscar. Con transactionId se consulta ese pago; sin él, uno que coincida con la orden. */
export interface PaymentSelector {
  transactionId?: string | null;
  orderId?: string | null;
  amountCents?: number | null;
}

export interface PaymentProvider {
  readonly name: "mock" | "pey";
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** null si el proveedor no tiene el pago pedido. No devuelve “el primer PAID” del QR. */
  getPayment(chargeId: string, selector?: PaymentSelector): Promise<VerifiedPayment | null>;
  cancelCharge(chargeId: string): Promise<void>;
  /** Devuelve el evento si la firma es válida; null si no lo es. */
  verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null>;
}
