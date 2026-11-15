// Lectura pública y limitada para la pantalla del cliente de puestos de demostración.
// No usa la sesión del comerciante ni devuelve secretWord antes de PAID.
import { serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { customerView, type OrderRow } from "../_shared/orders.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "GET") return json(req, { error: "method" }, 405);

  const stallId = new URL(req.url).searchParams.get("stallId") ?? "";
  if (!UUID.test(stallId)) return json(req, { error: "stallId" }, 400);

  try {
    const db = serviceClient();
    const { data: stall, error: stallError } = await db.from("stalls")
      .select("id").eq("id", stallId).eq("provider", "mock").eq("public_announce", true).maybeSingle();
    if (stallError) throw stallError;
    if (!stall) return json(req, { error: "not_found" }, 404);

    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const { data, error } = await db.from("orders").select("*")
      .eq("stall_id", stallId).eq("method", "codi").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    const visible = ((data ?? []) as OrderRow[]).filter((o) => !o.late_payment);
    return json(req, { orders: visible.map(customerView) });
  } catch (error) {
    console.error("public-orders", error);
    return json(req, { error: "internal_error" }, 500);
  }
});
