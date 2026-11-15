// PUT /catalog — alta o cambio de precio del puesto del comerciante autenticado.
import { ownedStall, requireUser } from "../_shared/auth.ts";
import { serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { parseCatalogBody } from "../_shared/items.ts";

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== "PUT") return json(req, { error: "method" }, 405);

  try {
    const caller = await requireUser(req);
    if (!caller) return json(req, { error: "unauthorized" }, 401);
    const parsed = parseCatalogBody(await req.json().catch(() => null));
    if ("error" in parsed) return json(req, { error: parsed.error }, parsed.error === "invalid_json" ? 400 : 422);
    const stall = await ownedStall(caller.userId, parsed.stallId);
    if (!stall) return json(req, { error: "forbidden" }, 403);

    const rows = parsed.items.map((item) => ({
      stall_id: parsed.stallId,
      name: item.name,
      aliases: item.aliases,
      unit: item.unit,
      price_cents: item.priceCents,
      active: item.active,
    }));
    const { data, error } = await serviceClient().from("catalog_items")
      .upsert(rows, { onConflict: "stall_id,name" })
      .select("id, name, aliases, unit, price_cents, active");
    if (error) throw new Error(error.message);
    return json(req, {
      items: (data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        aliases: row.aliases,
        unit: row.unit,
        priceCents: row.price_cents,
        active: row.active,
      })),
    });
  } catch (e) {
    console.error(e);
    return json(req, { error: "internal_error" }, 500);
  }
});
