// Una sola creación de QR por orden. La segunda solicitud espera el resultado de la primera.
// POST /codi/qr (OpenAPI pey 2026-10-20) no documenta Idempotency-Key. Un claim ocupado
// no se transfiere por tiempo, y un resultado incierto no autoriza otro QR.

export class UncertainChargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UncertainChargeError";
  }
}

export function isUncertainCharge(error: unknown): boolean {
  return error instanceof UncertainChargeError || (error instanceof Error && error.name === "UncertainChargeError");
}

/** true solo si nadie tiene el claim, o si ya es de este token. El reloj no lo libera. */
export function canTakeChargeClaim(
  current: { token: string | null; claimedAtMs: number | null },
  token: string,
  nowMs: number,
): boolean {
  if (!current.token) return true;
  if (current.token === token) return true;
  void nowMs;
  void current.claimedAtMs;
  return false;
}
export interface ChargeDraft {
  id: string;
  state: string;
  provider_charge_id: string | null;
  qr_payload: string | null;
  expires_at: string | null;
}

export interface CreatedCharge {
  chargeId: string;
  qrPayload: string;
  expiresAt: string;
}

export interface ChargeStore<T extends ChargeDraft> {
  claim(token: string): Promise<T | null>;
  read(): Promise<T | null>;
  /** Guarda el QR sin soltar el claim ni pasar a AWAITING_PAYMENT. */
  remember?(token: string, charge: CreatedCharge): Promise<void>;
  attach(token: string, charge: CreatedCharge): Promise<T | null>;
  fail(token: string): Promise<void>;
}

export type ChargeOnceResult<T> =
  | T
  | { error: "provider_error" }
  | { error: "in_progress" }
  | { error: "charge_uncertain"; charge?: CreatedCharge };

export async function createChargeOnce<T extends ChargeDraft>(
  store: ChargeStore<T>,
  create: (claimed: T) => Promise<CreatedCharge>,
  opts?: { sleep?: (ms: number) => Promise<void>; token?: string; attempts?: number },
): Promise<ChargeOnceResult<T>> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const token = opts?.token ?? crypto.randomUUID();
  const claimed = await store.claim(token);
  if (!claimed) return await waitForWinner(store, sleep, opts?.attempts ?? 40);

  let charge: CreatedCharge;
  try {
    charge = await create(claimed);
  } catch (error) {
    console.error("createCharge", error);
    if (isUncertainCharge(error)) return { error: "charge_uncertain" };
    await store.fail(token);
    return { error: "provider_error" };
  }

  // Ya hay un QR. Un fallo al guardarlo o leerlo no libera el claim y no autoriza otro.
  try {
    if (store.remember) await store.remember(token, charge);
    const saved = await store.attach(token, charge);
    if (saved) return saved;
    const current = await store.read();
    if (current?.provider_charge_id && current.qr_payload) return current;
    console.error("charge_not_stored", { orderId: claimed.id, chargeId: charge.chargeId });
    return { error: "charge_uncertain", charge };
  } catch (error) {
    console.error("charge_not_stored", { orderId: claimed.id, chargeId: charge.chargeId, error });
    return { error: "charge_uncertain", charge };
  }
}

async function waitForWinner<T extends ChargeDraft>(
  store: ChargeStore<T>,
  sleep: (ms: number) => Promise<void>,
  attempts: number,
): Promise<ChargeOnceResult<T>> {
  for (let i = 0; i < attempts; i++) {
    let current: T | null;
    try {
      current = await store.read();
    } catch (error) {
      console.error("readCharge", error);
      await sleep(25);
      continue;
    }
    if (!current) return { error: "in_progress" };
    if (current.provider_charge_id && current.qr_payload) return current;
    if (current.state === "FAILED" || current.state === "AWAITING_PAYMENT" || current.state === "PAID") return current;
    await sleep(25);
  }
  return { error: "in_progress" };
}
