// Conciliación: consulta al proveedor antes de expirar. Si no contesta, PENDING_UNKNOWN
// con reintentos hasta 30 min y una alerta; el reloj no demuestra que el pago no exista.
import { audit, serviceClient } from "./db.ts";
import type { OrderRow } from "./orders.ts";
import { getProvider } from "./providers/index.ts";
import type { VerifiedPayment } from "./providers/types.ts";
import { confirmedReconcilePayment } from "./reconcile_payment.ts";
import { type Probe, reconcileAction } from "./reconcile_policy.ts";

export async function reconcileOrders(stallId?: string): Promise<{
  paid: number;
  expired: number;
  unknown: number;
  alerted: number;
  purged: number;
}> {
  const db = serviceClient();
  const purged = await db.rpc("purge_old_utterances", { p_days: 30 })
    .then(({ data, error }) => {
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    })
    .catch((e) => {
      console.error("purge_old_utterances", e);
      return 0;
    });

  let q = db.from("orders").select("*").in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).limit(200);
  if (stallId) q = q.eq("stall_id", stallId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let paid = 0, expired = 0, unknown = 0, alerted = 0;
  const nowMs = Date.now();
  for (const o of (data ?? []) as OrderRow[]) {
    const actionPreview = reconcileAction({
      state: o.state,
      expiresAt: o.expires_at,
      nowMs,
      probe: "open",
      attempts: o.reconcile_attempts ?? 0,
      unknownSince: o.reconcile_unknown_since ?? null,
      nextReconcileAt: o.next_reconcile_at ?? null,
      alerted: !!o.reconcile_alerted_at,
    });
    if (actionPreview.kind === "skip") continue;

    let payment: VerifiedPayment | null | undefined = null;
    if (!o.provider || !o.provider_charge_id) {
      payment = undefined;
    } else {
      try {
        payment = await getProvider(o.provider).getPayment(o.provider_charge_id, {
          orderId: o.id,
          amountCents: o.amount_cents,
        });
      } catch (e) {
        console.error("getPayment", o.id, e);
        payment = undefined;
      }
    }
    const decision = payment ? confirmedReconcilePayment(o, payment) : null;
    if (decision && decision.reason !== "ok" && decision.reason !== "unconfirmed") {
      await audit(o.id, decision.reason, {
        via: "reconcile",
        expected: o.amount_cents,
        received: decision.amountCents ?? null,
        chargeId: o.provider_charge_id,
      });
      continue;
    }
    const probe: Probe = payment === undefined ? "unreachable" : decision?.pay ? "settled" : "open";

    const action = reconcileAction({
      state: o.state,
      expiresAt: o.expires_at,
      nowMs,
      probe,
      attempts: o.reconcile_attempts ?? 0,
      unknownSince: o.reconcile_unknown_since ?? null,
      nextReconcileAt: o.next_reconcile_at ?? null,
      alerted: !!o.reconcile_alerted_at,
    });

    if (action.kind === "pay" && decision?.pay && o.provider) {
      const { data: result, error: payErr } = await db.rpc("mark_order_paid", {
        p_provider: o.provider,
        p_event_id: decision.eventId,
        p_charge_id: decision.chargeId,
        p_order_id: o.id,
        p_amount_cents: decision.amountCents,
        p_transaction_id: decision.transactionId,
        p_tracking_key: decision.trackingKey,
        p_payload: { via: "reconcile", transactionId: decision.transactionId },
      });
      if (payErr) throw new Error(payErr.message);
      const outcome = (result as { outcome?: string } | null)?.outcome;
      if (outcome === "paid" || outcome === "late_paid") paid++;
    } else if (action.kind === "expire") {
      const { data: upd } = await db.from("orders").update({ state: "EXPIRED", next_reconcile_at: null })
        .eq("id", o.id).in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).select("id");
      if (upd?.length) {
        expired++;
        if (o.provider === "mock" && o.provider_charge_id) {
          await db.from("mock_charges").update({ status: "expired" })
            .eq("charge_id", o.provider_charge_id).eq("status", "pending");
        }
        await audit(o.id, "state_change", { from: o.state, to: "EXPIRED", via: "reconcile" });
      }
    } else if (action.kind === "wait") {
      await db.from("orders").update({ next_reconcile_at: action.nextReconcileAt })
        .eq("id", o.id).in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]);
    } else if (action.kind === "unknown") {
      const patch: Record<string, unknown> = {
        state: "PENDING_UNKNOWN",
        reconcile_attempts: action.attempts,
        reconcile_unknown_since: action.unknownSince,
        next_reconcile_at: action.nextReconcileAt,
      };
      if (action.alert) patch.reconcile_alerted_at = new Date(nowMs).toISOString();
      const { data: upd } = await db.from("orders").update(patch)
        .eq("id", o.id).in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).select("id");
      if (upd?.length) {
        unknown++;
        if (action.alert) {
          alerted++;
          await audit(o.id, "reconcile_exhausted", {
            attempts: action.attempts,
            since: action.unknownSince,
          });
        }
      }
    }
  }
  return { paid, expired, unknown, alerted, purged };
}
