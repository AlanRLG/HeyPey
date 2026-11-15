// GET /summary?stallId=&day=YYYY-MM-DD — corte del día, solo para el dueño del puesto.
import { ownedStall, requireUser } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { buildSummary, mexicoCityDay, type SummaryOrder } from "../_shared/summary.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "GET") return json(req, { error: "method" }, 405);

  try {
    const caller = await requireUser(req);
    if (!caller) return json(req, { error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const stallId = url.searchParams.get("stallId") ?? "";
    const day = url.searchParams.get("day") ?? mexicoCityDay();
    if (!DAY.test(day)) return json(req, { error: "day" }, 422);
    const stall = await ownedStall(caller.userId, stallId);
    if (!stall) return json(req, { error: "forbidden" }, 403);

    const { data, error } = await serviceClient().from("orders")
      .select("id, number, method, state, amount_cents, late_payment, reconcile_alerted_at")
      .eq("stall_id", stallId)
      .eq("business_day", day);
    if (error) throw new Error(error.message);
    return json(req, buildSummary(stallId, day, (data ?? []) as SummaryOrder[]));
  } catch (e) {
    console.error(e);
    return json(req, { error: "internal_error" }, 500);
  }
});
