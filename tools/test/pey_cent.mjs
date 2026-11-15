// Una sola orden CoDi de un centavo. La clave se escribe antes del POST y no se sustituye.
export const PEY_STALL_ID = "343eff54-061f-434c-b0fd-2611c058092d";
export const AMOUNT_CENTS = 1;
export const METHOD = "codi";
export const CONFIRM_PHRASE = "CREAR QR DE UN CENTAVO";
export const KEY_NAME = "idempotency-key";
export const ORDER_NAME = "order-id";
export const PAY_MARK_NAME = "pay-shown";

export function parseArgs(argv) {
  return {
    create: argv.includes("--crear"),
    wait: argv.includes("--esperar"),
  };
}

export function oneStall(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  return rows[0];
}

/** Solo el puesto pey sin cuenta propia: el cobro usa la cuenta de la API key. */
export function stallAllowsCent(row) {
  if (!row || row.provider !== "pey") return { ok: false, reason: "provider" };
  if (!Object.hasOwn(row, "provider_account_ref") || row.provider_account_ref !== null) {
    return { ok: false, reason: "account_ref" };
  }
  return { ok: true };
}

/** Sin --crear, o sin la frase exacta, no hay POST a /orders. */
export function mayCreateOrder({ createFlag, phrase, stall }) {
  if (!createFlag) return { post: false, reason: "lectura" };
  if (phrase !== CONFIRM_PHRASE) return { post: false, reason: "confirmacion" };
  const allowed = stallAllowsCent(stall);
  if (!allowed.ok) return { post: false, reason: allowed.reason };
  return { post: true };
}

function storedKey(text) {
  const key = typeof text === "string" ? text.trim() : "";
  if (!key) return null;
  if (key.length < 8 || /\s/.test(key)) throw new Error("clave_invalida");
  return key;
}

/**
 * Lee la clave ya guardada. Si no existe, la genera y la escribe antes de devolverla.
 * Una escritura que pierde la carrera relee el archivo: nunca manda una clave distinta.
 */
export function loadIdempotencyKey(fs, randomUUID) {
  const existing = storedKey(fs.read());
  if (existing) return { key: existing, reused: true };
  const generated = randomUUID();
  const fresh = storedKey(generated);
  if (!fresh) throw new Error("clave_invalida");
  try {
    fs.write(`${fresh}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stored = storedKey(fs.read());
  if (!stored) throw new Error("clave_no_guardada");
  return { key: stored, reused: stored !== fresh };
}

export function rememberOrderId(fs, orderId) {
  if (typeof orderId !== "string" || !/^[0-9a-f-]{36}$/i.test(orderId)) throw new Error("order_id");
  const existing = fs.read()?.trim() || null;
  if (existing && existing !== orderId) throw new Error("orden_distinta");
  if (!existing) fs.write(`${orderId}\n`);
  return orderId;
}

export function orderBody(idempotencyKey) {
  return {
    stallId: PEY_STALL_ID,
    amountCents: AMOUNT_CENTS,
    amountSource: "manual",
    method: METHOD,
    items: [],
    idempotencyKey,
  };
}

function orderIdOf(data) {
  return data && typeof data.orderId === "string" ? data.orderId : null;
}

/** Un timeout o un 5xx no autoriza otra clave ni otro POST en la misma ejecución. */
export function classifyCreateResult(input) {
  const orderId = orderIdOf(input.data);
  if (input.timedOut || input.networkError) return { kind: "uncertain", keepKey: true, orderId };
  const status = input.status ?? 0;
  const data = input.data;
  if (status === 201 && orderId && data.amountCents === AMOUNT_CENTS && data.method === METHOD) {
    return { kind: "ready", keepKey: true, orderId };
  }
  if (status === 0 || status >= 500 || status === 408 || status === 429 || status === 409) {
    return { kind: "uncertain", keepKey: true, orderId };
  }
  return { kind: "rejected", keepKey: true, orderId, status };
}

export function publicOrderById(payload, orderId) {
  const orders = payload && typeof payload === "object" ? payload.orders : null;
  if (!Array.isArray(orders)) return null;
  return orders.find((item) => item && item.orderId === orderId) ?? null;
}

/** La palabra oculta se juzga solo en esta orden, y solo mientras no esté PAID. */
export function orderHidesWord(publicOrder) {
  if (!publicOrder) return true;
  return publicOrder.secretWord == null || publicOrder.secretWord === "";
}

export function describeSavedOrder(merchant, publicStatus, payload) {
  if (!merchant || typeof merchant.state !== "string") return { ok: false, kind: "sin_orden" };
  const listed = publicOrderById(payload, merchant.orderId);
  if (merchant.state === "PAID" && merchant.latePayment) {
    return orderHidesWord(listed) ? { ok: true, kind: "tardia" } : { ok: false, kind: "palabra" };
  }
  if (merchant.state === "PAID") {
    const matches = publicStatus === 200
      && listed?.state === "PAID"
      && typeof merchant.secretWord === "string"
      && merchant.secretWord.length > 0
      && listed.secretWord === merchant.secretWord;
    return matches ? { ok: true, kind: "paid" } : { ok: false, kind: "palabra" };
  }
  if (typeof merchant.secretWord === "string" && merchant.secretWord && !orderHidesWord(listed)) {
    return { ok: false, kind: "filtracion" };
  }
  return { ok: true, kind: "oculta" };
}

/** Antes de la instrucción de pago: HTTP 200, esta orden, un centavo y palabra oculta. */
export function publicPayCheck(status, payload, orderId, merchantWord) {
  if (status !== 200) return { ok: false, reason: "public_http" };
  const listed = publicOrderById(payload, orderId);
  if (!listed) return { ok: false, reason: "ausente" };
  if (listed.amountCents !== AMOUNT_CENTS) return { ok: false, reason: "monto" };
  if (!orderHidesWord(listed)) return { ok: false, reason: "palabra" };
  if (typeof merchantWord === "string" && merchantWord && listed.secretWord === merchantWord) {
    return { ok: false, reason: "palabra" };
  }
  return { ok: true };
}

export function paymentPresentation(order, nowMs, markerExists) {
  if (markerExists) return { present: false, reason: "ya_mostrado" };
  if (!order || order.state !== "AWAITING_PAYMENT") return { present: false, reason: order?.state ?? "estado" };
  if (order.amountCents !== AMOUNT_CENTS || order.method !== METHOD) return { present: false, reason: "monto" };
  if (typeof order.qrPayload !== "string" || !order.qrPayload) return { present: false, reason: "qr" };
  const expiry = typeof order.expiresAt === "string" ? Date.parse(order.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= nowMs) return { present: false, reason: "qr_vencido" };
  return { present: true, reason: "listo" };
}

/** Escribe el marcador una sola vez. Si ya estaba, no se vuelve a pedir el pago. */
export function claimPayPrompt(fs) {
  if (fs.read()?.trim()) return { claimed: false };
  try {
    fs.write("shown\n");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { claimed: false };
  }
  if (fs.read()?.trim() !== "shown") throw new Error("marcador_no_guardado");
  return { claimed: true };
}

export function afterCreate(order, publicStatus, payload, nowMs, markerExists) {
  if (order?.state === "PAID") {
    const read = describeSavedOrder(order, publicStatus, payload);
    return { invite: false, ok: read.ok, kind: read.kind, keepKey: true };
  }
  if (order?.state !== "AWAITING_PAYMENT") {
    return { invite: false, ok: true, kind: "estado", keepKey: true };
  }
  const check = publicPayCheck(publicStatus, payload, order.orderId, order.secretWord);
  if (!check.ok) return { invite: false, ok: false, kind: check.reason, keepKey: true };
  const presentation = paymentPresentation(order, nowMs, markerExists);
  if (!presentation.present) return { invite: false, ok: true, kind: presentation.reason, keepKey: true };
  return { invite: true, ok: true, kind: "listo", keepKey: true };
}

export function readyToPay(order, nowMs = Date.now()) {
  return paymentPresentation(order, nowMs, false).present;
}

export function pollDecision(merchant, publicOrder) {
  if (merchant?.state === "PAID" && merchant.latePayment) return { done: true, ok: false, reason: "tardia" };
  if (merchant?.state === "PAID") {
    const matches = publicOrder?.state === "PAID"
      && typeof merchant.secretWord === "string"
      && merchant.secretWord.length > 0
      && publicOrder.secretWord === merchant.secretWord;
    return matches ? { done: true, ok: true } : { done: true, ok: false, reason: "palabra" };
  }
  return { done: false };
}

export function queryInstructions(base, orderId) {
  const root = base.replace(/\/$/, "");
  const id = orderId ?? "<orderId>";
  return [
    "La clave sigue en el archivo local. No se crea otra.",
    `Orden: GET ${root}/functions/v1/orders/${id}`,
    `Público: GET ${root}/functions/v1/public-orders?stallId=${PEY_STALL_ID}`,
    "No llames a mock-pay ni inventes un webhook. El script no transfiere.",
  ].join("\n");
}

export async function writeQrFiles(QRCode, paths, payload) {
  if (typeof payload !== "string" || !payload) throw new Error("qr_vacio");
  await QRCode.toFile(paths.png, payload, { type: "png", errorCorrectionLevel: "M", margin: 2 });
  const svg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  if (!svg.includes("<svg")) throw new Error("qr_svg");
  await paths.writeSvg(svg);
  return paths;
}
