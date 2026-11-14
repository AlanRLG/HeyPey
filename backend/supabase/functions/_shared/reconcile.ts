// Conciliación: vence órdenes sin pago y re-consulta las que quedaron en PENDING_UNKNOWN.
// Antes de vencer, consulta al proveedor: si ya está liquidada, la orden pasa a PAID.
import { audit, serviceClient } from "./db.ts";
import { getProvider } from "./providers/index.ts";
import type { OrderRow } from "./orders.ts";

export async function reconcileOrders(stallId?: string): Promise<{ paid: number; expired: number }> {
  const db = serviceClient();
  let q = db.from("orders").select("*").in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).limit(200);
  if (stallId) q = q.eq("stall_id", stallId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let paid = 0, expired = 0;
  const now = Date.now();
  for (const o of (data ?? []) as OrderRow[]) {
    const due = o.expires_at && new Date(o.expires_at).getTime() <= now;
    if (o.state === "AWAITING_PAYMENT" && !due) continue;
    if (!o.provider || !o.provider_charge_id) continue;

    const provider = getProvider(o.provider);
    const status = await provider.getStatus(o.provider_charge_id).catch(() => null);
    if (status === "settled") {
      const { data: upd } = await db.from("orders").update({ state: "PAID", paid_at: new Date().toISOString() })
        .eq("id", o.id).in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).select("id");
      if (upd?.length) { paid++; await audit(o.id, "state_change", { from: o.state, to: "PAID", via: "reconcile" }); }
    } else if (due) {
      const { data: upd } = await db.from("orders").update({ state: "EXPIRED" })
        .eq("id", o.id).in("state", ["AWAITING_PAYMENT", "PENDING_UNKNOWN"]).select("id");
      if (upd?.length) {
        expired++;
        if (o.provider === "mock") {
          await db.from("mock_charges").update({ status: "expired" }).eq("charge_id", o.provider_charge_id).eq("status", "pending");
        }
        await audit(o.id, "state_change", { from: o.state, to: "EXPIRED", via: "reconcile" });
      }
    }
  }
  return { paid, expired };
}
