// Adaptador pey® (Nivel 4). NO IMPLEMENTADO a propósito: la demo no conecta dinero real (AGENTS.md).
// [VERIFICAR] endpoints, campo de referencia, formato del webhook y esquema de firma en docs.pey.mx (brecha B7).
import type { ChargeStatus, CreateChargeInput, CreateChargeResult, PaymentProvider, WebhookEvent } from "./types.ts";

function notImplemented(): never {
  throw new Error("Proveedor pey no implementado: ver DEPLOY.md §5.2");
}

export const peyProvider: PaymentProvider = {
  name: "pey",
  createCharge(_input: CreateChargeInput): Promise<CreateChargeResult> { notImplemented(); },
  getStatus(_chargeId: string): Promise<ChargeStatus> { notImplemented(); },
  cancelCharge(_chargeId: string): Promise<void> { notImplemented(); },
  verifyWebhook(_req: Request, _rawBody: string): Promise<WebhookEvent | null> { notImplemented(); },
};
