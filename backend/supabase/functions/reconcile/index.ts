// reconcile — lo llama pg_cron cada minuto. Sin JWT; se autentica con x-cron-secret (brecha B3).
import { reconcileOrders } from "../_shared/reconcile.ts";

Deno.serve(async (req) => {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected || req.headers.get("x-cron-secret") !== expected) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  try {
    const result = await reconcileOrders();
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
  }
});
