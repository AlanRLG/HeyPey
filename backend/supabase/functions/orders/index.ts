// orders — crear, leer, corregir, listar y cancelar. Requiere JWT del comerciante.
import { requireUser, ownedStall, type StallRow } from "../_shared/auth.ts";
import { audit, serviceClient } from "../_shared/db.ts";
import { json, preflight } from "../_shared/http.ts";
import { createChargeOnce } from "../_shared/charge_once.ts";
import { itemsError } from "../_shared/items.ts";
import { ACTIVE_STATES, customerView, merchantView, type OrderRow } from "../_shared/orders.ts";
import { getProvider } from "../_shared/providers/index.ts";
import { mockQrPayload } from "../_shared/providers/mock.ts";
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
    if (req.method === "GET" && tail.length === 1) return await getOrder(req, tail[0], caller.userId);
    if (req.method === "POST" && tail.length === 0) return await createOrder(req, caller.userId);
    if (req.method === "POST" && tail.length === 2 && tail[1] === "cancel") return await cancelOrder(req, tail[0], caller.userId);
    if (req.method === "POST" && tail.length === 2 && tail[1] === "correct") return await correctOrder(req, tail[0], caller.userId);
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
  if (itemsError(items)) return json(req, { error: "items" }, 422);

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
  if (error) return orderRpcError(req, error.message);
  const ready = await fulfillCodi(req, created as OrderRow, stall);
  if (ready instanceof Response) return ready;
  return json(req, merchantView(ready), 201);
}

function orderRpcError(req: Request, message: string): Response {
  if (message.includes("no_secret_word_available")) return json(req, { error: "sin palabras disponibles" }, 503);
  if (message.includes("invalid_items")) return json(req, { error: "items" }, 422);
  if (message.includes("not_found")) return json(req, { error: "not_found" }, 404);
  if (message.includes("not_correctable") || message.includes("already_replaced") || message.includes("idempotency_reused")) {
    return json(req, { error: "estado" }, 409);
  }
  throw new Error(message);
}

// Reintenta el QR si la orden se quedó en CREATING o FAILED. claim_order_charge deja pasar
// una sola llamada a createCharge; el perdedor reutiliza ese QR.
async function fulfillCodi(req: Request, order: OrderRow, stall: StallRow): Promise<OrderRow | Response> {
  if (order.method !== "codi" || !["CREATING", "FAILED"].includes(order.state)) return order;
  const configured = Number.isFinite(ORDER_TTL_SECONDS) && ORDER_TTL_SECONDS > 0 ? ORDER_TTL_SECONDS : 180;
  const ttl = stall.provider === "pey" ? Math.max(configured, 360) : configured;
  const db = serviceClient();
  const outcome = await createChargeOnce<OrderRow>({
    claim: async (token) => {
      const { data, error } = await db.rpc("claim_order_charge", {
        p_order: order.id,
        p_token: token,
        p_ttl_seconds: ttl,
      }).maybeSingle();
      if (error) throw new Error(error.message);
      return data as OrderRow | null;
    },
    read: async () => {
      const { data, error } = await db.from("orders").select("*").eq("id", order.id).maybeSingle();
      if (error) throw new Error(error.message);
      return data as OrderRow | null;
    },
    remember: async (token, charge) => {
      const { error } = await db.from("orders").update({
        held_charge_id: charge.chargeId,
        held_qr_payload: charge.qrPayload,
        held_expires_at: charge.expiresAt,
      }).eq("id", order.id).eq("charge_claim", token).eq("state", "CREATING").is("provider_charge_id", null).is("held_charge_id", null);
      if (error) throw new Error(error.message);
    },
    attach: async (token, charge) => {
      const { data, error } = await db.from("orders").update({
        state: "AWAITING_PAYMENT",
        provider: stall.provider,
        provider_charge_id: charge.chargeId,
        qr_payload: charge.qrPayload,
        expires_at: charge.expiresAt,
        charge_claim: null,
      }).eq("id", order.id).eq("charge_claim", token).eq("state", "CREATING").select("*").maybeSingle();
      if (error) throw new Error(error.message);
      if (data) await audit(order.id, "state_change", { from: "CREATING", to: "AWAITING_PAYMENT", chargeId: charge.chargeId });
      return data as OrderRow | null;
    },
    fail: async (token) => {
      await db.from("orders").update({ state: "FAILED", charge_claim: null })
        .eq("id", order.id).eq("charge_claim", token).eq("state", "CREATING");
      await audit(order.id, "state_change", { from: "CREATING", to: "FAILED" });
    },
  }, async (claimed) => {
    if (stall.provider === "mock") {
      const { data: existing } = await db.from("mock_charges")
        .select("charge_id, amount_cents").eq("reference", claimed.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (existing && existing.amount_cents === claimed.amount_cents) {
        return {
          chargeId: existing.charge_id,
          qrPayload: mockQrPayload(existing.charge_id, claimed.amount_cents, claimed.id),
          expiresAt: claimed.expires_at ?? new Date(Date.now() + ttl * 1000).toISOString(),
        };
      }
    }
    const charge = await getProvider(stall.provider).createCharge({
      orderId: claimed.id,
      amountCents: claimed.amount_cents,
      expiresAt: claimed.expires_at ?? new Date(Date.now() + ttl * 1000).toISOString(),
      accountRef: stall.provider_account_ref,
      concept: `Orden ${claimed.number}`,
    });
    return { chargeId: charge.chargeId, qrPayload: charge.qrPayload, expiresAt: charge.expiresAt };
  });
  if ("error" in outcome) {
    if (outcome.error === "charge_uncertain" && outcome.charge) {
      console.error("charge_uncertain", { orderId: order.id, chargeId: outcome.charge.chargeId, qrPayload: outcome.charge.qrPayload });
    }
    const status = outcome.error === "provider_error" ? 502 : 409;
    return json(req, { error: outcome.error, orderId: order.id }, status);
  }
  return outcome;
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
  const visible = view === "customer" ? rows.filter((o) => !o.late_payment) : rows;
  return json(req, {
    view,
    orders: view === "customer" ? visible.map(customerView) : visible.map(merchantView),
    serverTime: new Date().toISOString(),
  });
}

async function getOrder(req: Request, orderId: string, userId: string): Promise<Response> {
  const { data } = await serviceClient().from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!data || !(await ownedStall(userId, data.stall_id))) return json(req, { error: "not_found" }, 404);
  return json(req, merchantView(data as OrderRow));
}

async function correctOrder(req: Request, orderId: string, userId: string): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return json(req, { error: "invalid_json" }, 400);
  const { amountCents, amountSource = "manual", items = [], utterance = null, idempotencyKey } = body;
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) return json(req, { error: "idempotencyKey" }, 400);
  if (!Number.isInteger(amountCents) || amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return json(req, { error: "monto", minAmountCents: MIN_AMOUNT_CENTS, maxAmountCents: MAX_AMOUNT_CENTS }, 422);
  }
  if (!["manual", "spoken", "catalog"].includes(amountSource)) return json(req, { error: "amountSource" }, 422);
  if (itemsError(items)) return json(req, { error: "items" }, 422);

  const db = serviceClient();
  const { data: previous } = await db.from("orders")
    .select("id, stall_id, provider, provider_charge_id").eq("id", orderId).maybeSingle();
  if (!previous) return json(req, { error: "not_found" }, 404);
  const stall = await ownedStall(userId, previous.stall_id);
  if (!stall) return json(req, { error: "not_found" }, 404);

  const { data: created, error } = await db.rpc("correct_order", {
    p_order: orderId,
    p_amount_cents: amountCents,
    p_source: amountSource,
    p_items: items,
    p_utterance: typeof utterance === "string" ? utterance.slice(0, 500) : null,
    p_idem: idempotencyKey,
    p_user: userId,
    p_provider: stall.provider,
    p_ttl_seconds: ORDER_TTL_SECONDS,
  }).single();
  if (error) return orderRpcError(req, error.message);

  if (previous.provider && previous.provider_charge_id) {
    await getProvider(previous.provider).cancelCharge(previous.provider_charge_id).catch(() => {});
  }
  const ready = await fulfillCodi(req, created as OrderRow, stall);
  if (ready instanceof Response) return ready;
  return json(req, { ...merchantView(ready), replaces: orderId }, 201);
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
