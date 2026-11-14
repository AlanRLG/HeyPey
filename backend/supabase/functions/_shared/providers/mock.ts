// MockProvider: simula un cobro CoDi sin banco ni dinero real.
// Las cargas viven en la tabla mock_charges (brecha B2) para que getStatus sea real.
import { serviceClient } from "../db.ts";
import type { ChargeStatus, CreateChargeInput, CreateChargeResult, PaymentProvider, WebhookEvent } from "./types.ts";

const SIGNATURE_TOLERANCE_S = 300;

function secret(): string {
  const s = Deno.env.get("MOCK_WEBHOOK_SECRET");
  if (!s) throw new Error("MOCK_WEBHOOK_SECRET no configurado");
  return s;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Firma con el formato `t=<unix>,v1=<hmac_sha256(secret, "<t>.<body>")>`. */
export async function signMockPayload(body: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret(), `${timestamp}.${body}`)}`;
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
    const amount = (input.amountCents / 100).toFixed(2);
    // Carga útil claramente simulada: no es un QR CoDi válido.
    return { chargeId, qrPayload: `MOCKCODI|SIMULADO|${chargeId}|${amount}|MXN|${input.orderId}` };
  },

  async getStatus(chargeId: string): Promise<ChargeStatus> {
    const { data, error } = await serviceClient().from("mock_charges").select("status").eq("charge_id", chargeId).maybeSingle();
    if (error) throw new Error(`mock_charges: ${error.message}`);
    return (data?.status as ChargeStatus) ?? "failed";
  },

  async cancelCharge(chargeId: string): Promise<void> {
    await serviceClient().from("mock_charges").update({ status: "cancelled" }).eq("charge_id", chargeId).eq("status", "pending");
  },

  async verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null> {
    const header = req.headers.get("x-mock-signature") ?? "";
    const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
    const t = Number(parts.t);
    if (!parts.v1 || !Number.isFinite(t)) return null;
    if (Math.abs(Date.now() / 1000 - t) > SIGNATURE_TOLERANCE_S) return null;
    const expected = await hmacHex(secret(), `${t}.${rawBody}`);
    if (!timingSafeEqual(expected, parts.v1)) return null;

    const body = JSON.parse(rawBody);
    return {
      eventId: String(body.eventId),
      chargeId: String(body.chargeId),
      reference: String(body.reference),
      amountCents: Number(body.amountCents),
      status: body.status as ChargeStatus,
      trackingKey: body.trackingKey ?? null,
      raw: body,
    };
  },
};
