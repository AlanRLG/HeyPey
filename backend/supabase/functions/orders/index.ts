// orders — crear (POST /orders), listar (GET /orders?stallId=&view=merchant|customer)
// y cancelar (POST /orders/<id>/cancel). Requiere JWT del comerciante.
import { requireUser, ownedStall } from "../_shared/auth.ts";
import { audit, serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { ACTIVE_STATES, customerView, merchantView, type OrderRow } from "../_shared/orders.ts";
import { getProvider } from "../_shared/providers/index.ts";
import { reconcileOrders } from "../_shared/reconcile.ts";

const MIN_AMOUNT_CENTS = Number(Deno.env.get("MIN_AMOUNT_CENTS") ?? "500");
const MAX_AMOUNT_CENTS = 5_000_000;
const ORDER_TTL_SECONDS = Number(Deno.env.get("ORDER_TTL_SECONDS") ?? "180");

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;

  try {
    const caller = await requireUser(req);
    if (!caller) return json(req, { error: "unauthorized" }, 401);

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // [..., "orders", "<id>", "cancel"]
    const idx = parts.lastIndexOf("orders");
    const tail = idx >= 0 ? parts.slice(idx + 1) : [];

    if (req.method === "GET" && tail.length === 0) return await listOrders(req, url, caller.userId);
    if (req.method === "POST" && tail.length === 0) return await createOrder(req, caller.userId);
    if (req.method === "POST" && tail.length === 2 && tail[1] === "cancel") return await cancelOrder(req, tail[0], caller.userId);
    return json(req, { error: "not_found" }, 404);
  } catch (e) {
    console.error(e);
    return json(req, { error: "internal_error" }, 500);
  }
});

async function createOrder(req: Request, userId: string): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return json(req, { error: "invalid_json" }, 400);

  const { stallId, amountCents, amountSource = "manual", method = "codi", items = [], utterance = null, idempotencyKey } = body;
  if (typeof stallId !== "string" || typeof idempotencyKey !== "string" || idempotencyKey.length < 8) {
    return json(req, { error: "stallId e idempotencyKey son obligatorios" }, 400);
  }
  if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return json(req, { error: "monto", minAmountCents: MIN_AMOUNT_CENTS, maxAmountCents: MAX_AMOUNT_CENTS }, 422);
  }
  if (!["codi", "cash"].includes(method)) return json(req, { error: "method" }, 422);
  if (!["manual", "spoken", "catalog"].includes(amountSource)) return json(req, { error: "amountSource" }, 422);
  if (!Array.isArray(items)) return json(req, { error: "items" }, 422);

  const stall = await ownedStall(userId, stallId);
  if (!stall) return json(req, { error: "forbidden" }, 403);

  const db = serviceClient();
  const { data: created, error } = await db.rpc("create_order", {
    p_stall: stallId,
    p_amount_cents: amountCents,
    p_source: amountSource,
    p_method: method,
    p_items: items,
    p_utterance: typeof utterance === "string" ? utterance.slice(0, 500) : null,
    p_idem: idempotencyKey,
    p_user: userId,
    p_provider: stall.provider,
    p_ttl_seconds: ORDER_TTL_SECONDS,
  }).single();
  if (error) {
    if (error.message.includes("no_secret_word_available")) return json(req, { error: "sin palabras disponibles" }, 503);
    throw new Error(error.message);
  }
  let order = created as OrderRow;

  // Orden nueva CoDi: crear la carga en el proveedor y pasar a AWAITING_PAYMENT.
  if (order.state === "CREATING") {
    try {
      const provider = getProvider(stall.provider);
      const charge = await provider.createCharge({
        orderId: order.id,
        amountCents: order.amount_cents,
        expiresAt: order.expires_at!,
        accountRef: stall.provider_account_ref,
      });
      const { data: upd, error: updErr } = await db.from("orders")
        .update({ state: "AWAITING_PAYMENT", provider_charge_id: charge.chargeId, qr_payload: charge.qrPayload })
        .eq("id", order.id).eq("state", "CREATING").select("*").single();
      if (updErr) throw new Error(updErr.message);
      order = upd as OrderRow;
      await audit(order.id, "state_change", { from: "CREATING", to: "AWAITING_PAYMENT", chargeId: charge.chargeId });
    } catch (e) {
      await db.from("orders").update({ state: "FAILED" }).eq("id", order.id).eq("state", "CREATING");
      await audit(order.id, "state_change", { from: "CREATING", to: "FAILED", error: String(e) });
      return json(req, { error: "provider_error", orderId: order.id }, 502);
    }
  }

  return json(req, merchantView(order), 201);
}

async function listOrders(req: Request, url: URL, userId: string): Promise<Response> {
  const stallId = url.searchParams.get("stallId") ?? "";
  const view = url.searchParams.get("view") === "customer" ? "customer" : "merchant";
  const stall = await ownedStall(userId, stallId);
  if (!stall) return json(req, { error: "forbidden" }, 403);

  // Respaldo del cron: vence lo que ya expiró antes de responder al polling.
  await reconcileOrders(stallId).catch((e) => console.error("reconcile", e));

  const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const { data, error } = await serviceClient().from("orders").select("*")
    .eq("stall_id", stallId).gte("created_at", since)
    .order("created_at", { ascending: false }).limit(view === "customer" ? 10 : 50);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as OrderRow[];
  return json(req, {
    view,
    orders: view === "customer" ? rows.map(customerView) : rows.map(merchantView),
    serverTime: new Date().toISOString(),
  });
}

async function cancelOrder(req: Request, orderId: string, userId: string): Promise<Response> {
  const db = serviceClient();
  const { data: order } = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order || !(await ownedStall(userId, order.stall_id))) return json(req, { error: "not_found" }, 404);
  if (!ACTIVE_STATES.includes(order.state)) return json(req, { error: "estado", state: order.state }, 409);

  const { data: upd } = await db.from("orders").update({ state: "CANCELLED" })
    .eq("id", orderId).in("state", ACTIVE_STATES).select("*").maybeSingle();
  if (!upd) return json(req, { error: "estado" }, 409);
  if (order.provider && order.provider_charge_id) {
    await getProvider(order.provider).cancelCharge(order.provider_charge_id).catch(() => {});
  }
  await audit(orderId, "state_change", { from: order.state, to: "CANCELLED" });
  return json(req, merchantView(upd as OrderRow));
}
