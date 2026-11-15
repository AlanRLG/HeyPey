// MockProvider: simula un cobro CoDi sin banco ni dinero real.
// Las cargas viven en mock_charges. getPayment lee esa fila; no hay un estado suelto.
import { serviceClient } from "../db.ts";
import { signMockPayloadWithSecret, verifyMockSignature } from "./mock_sign.ts";
import type { ChargeStatus, CreateChargeInput, CreateChargeResult, PaymentProvider, PaymentSelector, WebhookEvent } from "./types.ts";

function secret(): string {
  const s = Deno.env.get("MOCK_WEBHOOK_SECRET");
  if (!s) throw new Error("MOCK_WEBHOOK_SECRET no configurado");
  return s;
}

/** Firma con el formato `t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>`. */
export async function signMockPayload(body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return signMockPayloadWithSecret(secret(), body, timestamp);
}

export function mockQrPayload(chargeId: string, amountCents: number, orderId: string): string {
  return `MOCKCODI|SIMULADO|${chargeId}|${(amountCents / 100).toFixed(2)}|MXN|${orderId}`;
}

export const mockProvider: PaymentProvider = {
  name: "mock",

  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const chargeId = `mock_${crypto.randomUUID().replaceAll("-", "")}`;
    const db = serviceClient();
    const { error } = await db.from("mock_charges").insert({
      charge_id: chargeId,
      amount_cents: input.amountCents,
      reference: input.orderId,
    });
    if (error) throw new Error(`mock_charges: ${error.message}`);
    return { chargeId, qrPayload: mockQrPayload(chargeId, input.amountCents, input.orderId), expiresAt: input.expiresAt };
  },

  async getPayment(chargeId: string, selector?: PaymentSelector) {
    const { data, error } = await serviceClient().from("mock_charges")
      .select("charge_id, status, amount_cents, reference, transaction_id, tracking_key")
      .eq("charge_id", chargeId).maybeSingle();
    if (error) throw new Error(`mock_charges: ${error.message}`);
    if (!data || data.status !== "settled" || typeof data.transaction_id !== "string" || !data.transaction_id) return null;
    if (selector?.transactionId && data.transaction_id !== selector.transactionId) return null;
    if (selector?.orderId && data.reference !== selector.orderId) return null;
    if (!Number.isInteger(data.amount_cents)) return null;
    return {
      chargeId: data.charge_id as string,
      transactionId: data.transaction_id,
      amountCents: data.amount_cents as number,
      trackingKey: (data.tracking_key as string | null) ?? null,
      reference: (data.reference as string | null) ?? null,
    };
  },

  async cancelCharge(chargeId: string): Promise<void> {
    await serviceClient().from("mock_charges").update({ status: "cancelled" }).eq("charge_id", chargeId).eq("status", "pending");
  },

  async verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null> {
    const header = req.headers.get("x-mock-signature") ?? "";
    if (!(await verifyMockSignature(secret(), header, rawBody))) return null;
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody); } catch { return null; }
    return {
      eventId: String(body.eventId),
      chargeId: String(body.chargeId),
      reference: String(body.reference),
      amountCents: Number(body.amountCents),
      status: body.status as ChargeStatus,
      trackingKey: typeof body.trackingKey === "string" ? body.trackingKey : null,
      transactionId: typeof body.transactionId === "string"
        ? body.transactionId
        : typeof body.trackingKey === "string" ? body.trackingKey : null,
      raw: body,
    };
  },
};
