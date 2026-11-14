// Contrato común de proveedores de pago. La app nunca decide un pago: solo el servidor,
// con un evento firmado del proveedor y una consulta independiente de estado (getStatus).

export type ChargeStatus = "pending" | "settled" | "expired" | "failed" | "cancelled";

export interface CreateChargeInput {
  orderId: string;
  amountCents: number;
  expiresAt: string;
  accountRef: string | null;
}

export interface CreateChargeResult {
  chargeId: string;
  qrPayload: string;
}

export interface WebhookEvent {
  eventId: string;
  chargeId: string;
  reference: string; // debe mapear a orders.id
  amountCents: number;
  status: ChargeStatus;
  trackingKey?: string | null;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: "mock" | "pey";
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  getStatus(chargeId: string): Promise<ChargeStatus>;
  cancelCharge(chargeId: string): Promise<void>;
  /** Devuelve el evento si la firma es válida; null si no lo es. */
  verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null>;
}
