// Decide qué hacer con una orden vencida o en PENDING_UNKNOWN.
// El vencimiento por sí solo no prueba que no hubo pago: si el proveedor no contesta,
// se reintenta hasta 30 minutos y después queda una alerta, sin pasar a EXPIRED.

export const RECONCILE_GRACE_MS = 20_000;
export const RECONCILE_WINDOW_MS = 30 * 60_000;

export type Probe = "settled" | "open" | "unreachable" | "rejected";

export interface ReconcileInput {
  state: string;
  expiresAt: string | null;
  nowMs: number;
  probe: Probe;
  attempts: number;
  unknownSince: string | null;
  nextReconcileAt: string | null;
  alerted: boolean;
}

export type ReconcileAction =
  | { kind: "skip" }
  | { kind: "pay" }
  | { kind: "expire" }
  | { kind: "wait"; nextReconcileAt: string }
  | {
    kind: "unknown";
    attempts: number;
    unknownSince: string;
    nextReconcileAt: string | null;
    alert: boolean;
  }
  | {
    kind: "review";
    attempts: number;
    unknownSince: string;
    nextReconcileAt: string;
    alert: boolean;
  };

export function backoffMs(attempt: number): number {
  const steps = Math.min(2 ** Math.max(0, attempt - 1), 16);
  return steps * 60_000;
}

/** Hay que consultar al proveedor aunque ya exista una alerta. La alerta no demuestra que no se pagó. */
export function shouldConsultProvider(input: Omit<ReconcileInput, "probe" | "alerted">): boolean {
  return reconcileAction({ ...input, probe: "open", alerted: false }).kind !== "skip";
}

export function reconcileAction(input: ReconcileInput): ReconcileAction {
  if (input.probe === "rejected") {
    const unknownSince = input.unknownSince ?? new Date(input.nowMs).toISOString();
    const attempts = input.attempts + 1;
    return {
      kind: "review",
      attempts,
      unknownSince,
      nextReconcileAt: new Date(input.nowMs + backoffMs(attempts)).toISOString(),
      alert: !input.alerted,
    };
  }
  if (input.alerted && input.probe !== "settled") return { kind: "skip" };

  const expiry = input.expiresAt ? Date.parse(input.expiresAt) : null;
  const due = expiry != null && input.nowMs >= expiry + RECONCILE_GRACE_MS;
  const waiting = input.state === "PENDING_UNKNOWN"
    && input.nextReconcileAt != null
    && Date.parse(input.nextReconcileAt) > input.nowMs;

  if (input.probe !== "settled" && (input.state === "AWAITING_PAYMENT" && !due || waiting)) {
    return { kind: "skip" };
  }
  if (input.probe === "settled") return { kind: "pay" };
  if (input.probe === "open" && due) return { kind: "expire" };
  if (input.probe === "open") {
    const next = expiry != null
      ? new Date(expiry + RECONCILE_GRACE_MS).toISOString()
      : new Date(input.nowMs + 60_000).toISOString();
    return { kind: "wait", nextReconcileAt: next };
  }

  const unknownSince = input.unknownSince ?? new Date(input.nowMs).toISOString();
  const attempts = input.attempts + 1;
  const elapsed = input.nowMs - Date.parse(unknownSince);
  const alert = elapsed >= RECONCILE_WINDOW_MS;
  return {
    kind: "unknown",
    attempts,
    unknownSince,
    nextReconcileAt: alert ? null : new Date(input.nowMs + backoffMs(attempts)).toISOString(),
    alert,
  };
}
