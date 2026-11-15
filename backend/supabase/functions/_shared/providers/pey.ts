// Adaptador pey según el OpenAPI de docs.pey.mx (versión 2026-10-20, consultado el 15 nov 2026).
// POST /codi/qr no documenta Idempotency-Key ni otro campo de idempotencia.
// GET /transaction/{id} confirma el transactionId del webhook. GET /transaction/codi/qr/{id}
// lista los pagos del QR para conciliar sin webhook. No existe cancelación de QR.
// PEY_LIVE_ENABLED debe ser "true" para cualquier request. Por defecto está apagado.
// [VERIFICAR] con un evento real que metadata.orderId regrese en metadata.externalMetadata.orderId
// y que payableId sea el IDC del QR.
import { UncertainChargeError } from "../charge_once.ts";
import { selectPaymentForOrder } from "../reconcile_payment.ts";
import { centsToPesos, pesosToCents } from "./money.ts";
import { verifyStandardWebhook } from "./standard_webhooks.ts";
import type {
  CreateChargeInput,
  CreateChargeResult,
  PaymentProvider,
  PaymentSelector,
  VerifiedPayment,
  WebhookEvent,
} from "./types.ts";

const MIN_EXPIRATION_S = 360;
const DEFAULT_BASE = "https://api.pey.mx";

export interface PeyOptions {
  fetch?: typeof fetch;
  live?: boolean;
  baseUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  bankAccountId?: string | null;
  now?: () => number;
}

function readEnv(name: string): string | undefined {
  if (typeof Deno === "undefined") return undefined;
  const value = Deno.env.get(name);
  return value ? value : undefined;
}

export function numRefForOrder(orderId: string): string {
  let hash = 0;
  for (const char of orderId) hash = (Math.imul(hash, 33) + char.charCodeAt(0)) >>> 0;
  const ref = String(hash % 10_000_000);
  return ref === "0" ? "1" : ref;
}

export function peyExpirationSeconds(expiresAt: string, nowMs: number): number {
  const requested = Math.ceil((Date.parse(expiresAt) - nowMs) / 1000);
  if (!Number.isFinite(requested) || requested < MIN_EXPIRATION_S) return MIN_EXPIRATION_S;
  return requested;
}

function orderIdFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  const external = record.externalMetadata;
  if (external && typeof external === "object") {
    const orderId = (external as Record<string, unknown>).orderId;
    if (typeof orderId === "string" && orderId) return orderId;
  }
  return typeof record.orderId === "string" && record.orderId ? record.orderId : null;
}

function trackingFromMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const key = (metadata as Record<string, unknown>).trackingKey;
  return typeof key === "string" && key ? key : null;
}

export function createPeyProvider(options: PeyOptions = {}): PaymentProvider {
  const live = options.live ?? readEnv("PEY_LIVE_ENABLED") === "true";
  const baseUrl = (options.baseUrl ?? readEnv("PEY_BASE_URL") ?? DEFAULT_BASE).replace(/\/$/, "");
  const apiKey = options.apiKey ?? readEnv("PEY_API_KEY") ?? "";
  const webhookSecret = options.webhookSecret ?? readEnv("PEY_WEBHOOK_SECRET") ?? "";
  const bankAccountId = options.bankAccountId === undefined
    ? (readEnv("PEY_BANK_ACCOUNT_ID") ?? null)
    : options.bankAccountId;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? (() => Date.now());

  async function peyFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!live) throw new Error("pey_live_disabled");
    if (!apiKey) throw new Error("pey_api_key_missing");
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return fetchImpl(`${baseUrl}${path}`, { ...init, headers });
  }

  function paymentFromRow(chargeId: string, row: Record<string, unknown>): VerifiedPayment {
    const cents = pesosToCents(typeof row.amount === "number" ? row.amount : Number.NaN);
    if (cents == null || typeof row.id !== "string" || !row.id) throw new Error("pey_payment_shape");
    return {
      chargeId,
      transactionId: row.id,
      amountCents: cents,
      trackingKey: trackingFromMetadata(row.metadata),
      reference: orderIdFromMetadata(row.metadata),
    };
  }

  async function paymentByTransaction(chargeId: string, transactionId: string): Promise<VerifiedPayment | null> {
    const res = await peyFetch(`/transaction/${encodeURIComponent(transactionId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`pey_transaction_${res.status}`);
    const row = await res.json() as Record<string, unknown>;
    if (row.status !== "PAID" || row.id !== transactionId) return null;
    if (row.payableType != null && row.payableType !== "API_CODI_QR") return null;
    if (row.payableId !== chargeId) return null;
    return paymentFromRow(chargeId, row);
  }

  async function paymentsForQr(chargeId: string): Promise<VerifiedPayment[]> {
    const found: VerifiedPayment[] = [];
    let token: string | null = null;
    for (let page = 0; page < 5; page++) {
      const query = token ? `?nextToken=${encodeURIComponent(token)}` : "";
      const res = await peyFetch(`/transaction/codi/qr/${encodeURIComponent(chargeId)}${query}`);
      if (res.status === 404) return found;
      if (!res.ok) throw new Error(`pey_transactions_${res.status}`);
      const body = await res.json() as { items?: unknown[]; nextToken?: unknown };
      for (const item of body.items ?? []) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (row.status !== "PAID") continue;
        if (typeof row.payableId === "string" && row.payableId !== chargeId) continue;
        found.push(paymentFromRow(chargeId, row));
      }
      token = typeof body.nextToken === "string" && body.nextToken ? body.nextToken : null;
      if (!token) break;
    }
    return found;
  }

  async function getPayment(chargeId: string, selector?: PaymentSelector): Promise<VerifiedPayment | null> {
    if (selector?.transactionId) return await paymentByTransaction(chargeId, selector.transactionId);
    if (!selector?.orderId) return null;
    const payments = await paymentsForQr(chargeId);
    return selectPaymentForOrder({
      id: selector.orderId,
      amount_cents: selector.amountCents ?? Number.NaN,
      provider_charge_id: chargeId,
    }, payments);
  }

  return {
    name: "pey",

    async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
      const nowMs = now();
      const expiration = peyExpirationSeconds(input.expiresAt, nowMs);
      const payload: Record<string, unknown> = {
        amount: centsToPesos(input.amountCents),
        concept: input.concept ?? "Orden",
        expiration,
        numRef: numRefForOrder(input.orderId),
        metadata: { orderId: input.orderId },
      };
      if (bankAccountId) payload.bankAccountId = bankAccountId;
      let res: Response;
      try {
        res = await peyFetch("/codi/qr", { method: "POST", body: JSON.stringify(payload) });
      } catch (error) {
        if (error instanceof Error && (error.message === "pey_live_disabled" || error.message === "pey_api_key_missing")) throw error;
        throw new UncertainChargeError("pey_create_uncertain");
      }
      if (res.status >= 500 || res.status === 408 || res.status === 429) throw new UncertainChargeError(`pey_create_${res.status}`);
      if (!res.ok) throw new Error(`pey_create_${res.status}`);
      const body = await res.json().catch(() => null) as { id?: unknown; qrString?: unknown } | null;
      if (!body || typeof body.id !== "string" || typeof body.qrString !== "string") {
        throw new UncertainChargeError("pey_create_shape");
      }
      return {
        chargeId: body.id,
        qrPayload: body.qrString,
        expiresAt: new Date(nowMs + expiration * 1000).toISOString(),
      };
    },

    getPayment,

    async cancelCharge(_chargeId: string): Promise<void> {
      // El OpenAPI público no tiene un endpoint para invalidar un QR CoDi.
      throw new Error("pey_no_remote_cancel");
    },

    async verifyWebhook(req: Request, rawBody: string): Promise<WebhookEvent | null> {
      if (!webhookSecret) return null;
      const webhookId = req.headers.get("webhook-id");
      const ok = await verifyStandardWebhook(webhookSecret, {
        id: webhookId,
        timestamp: req.headers.get("webhook-timestamp"),
        signature: req.headers.get("webhook-signature"),
      }, rawBody, now());
      if (!ok) return null;
      let body: Record<string, unknown>;
      try { body = JSON.parse(rawBody); } catch { return null; }
      if (body.type !== "codi.qr.payment_received") {
        return {
          eventId: webhookId ?? "",
          chargeId: typeof body.codiQrId === "string" ? body.codiQrId : "",
          reference: "",
          amountCents: 0,
          status: "pending",
          raw: body,
        };
      }
      const cents = pesosToCents(typeof body.amount === "number" ? body.amount : Number.NaN);
      if (cents == null || typeof body.codiQrId !== "string" || typeof body.transactionId !== "string") return null;
      return {
        eventId: webhookId ?? body.transactionId,
        chargeId: body.codiQrId,
        reference: orderIdFromMetadata(body.metadata) ?? "",
        amountCents: cents,
        status: "settled",
        trackingKey: trackingFromMetadata(body.metadata),
        transactionId: body.transactionId,
        raw: body,
      };
    },
  };
}

export const peyProvider = createPeyProvider();
