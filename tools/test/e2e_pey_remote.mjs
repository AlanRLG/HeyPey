// Una sola prueba real de $0.01 MXN contra el puesto pey. No se ejecuta al importarse.
// Por defecto solo lee. El QR exige --crear y la frase CREAR QR DE UN CENTAVO en el terminal.
// No transfiere, no llama a mock-pay, no inventa webhooks y no cambia PEY_LIVE_ENABLED.
//
//   node tools/test/e2e_pey_remote.mjs
//   node tools/test/e2e_pey_remote.mjs --crear
//   node tools/test/e2e_pey_remote.mjs --esperar
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AMOUNT_CENTS,
  CONFIRM_PHRASE,
  KEY_NAME,
  METHOD,
  ORDER_NAME,
  PAY_MARK_NAME,
  PEY_STALL_ID,
  afterCreate,
  claimPayPrompt,
  classifyCreateResult,
  describeSavedOrder,
  loadIdempotencyKey,
  mayCreateOrder,
  oneStall,
  orderBody,
  orderHidesWord,
  parseArgs,
  pollDecision,
  publicOrderById,
  queryInstructions,
  rememberOrderId,
  stallAllowsCent,
  writeQrFiles,
} from "./pey_cent.mjs";
import { promptLine, promptSecret, signIn } from "./remote_session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const localDir = join(here, ".pey-cent");

function fileStore(name) {
  const path = join(localDir, name);
  return {
    read() {
      try { return readFileSync(path, "utf8"); }
      catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    },
    write(text) {
      mkdirSync(localDir, { recursive: true });
      writeFileSync(path, text, { flag: "wx" });
    },
  };
}

function publicValue(name) {
  const config = readFileSync(resolve(root, "tools/simulator/config.js"), "utf8");
  return config.match(new RegExp(`${name}:\\s*["']([^"']+)["']`))?.[1] ?? "";
}

function safeCode(data) {
  const code = data && typeof data.error === "string" ? data.error : "";
  return /^[a-z0-9_]+$/.test(code) ? code : "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = (process.env.TEST_SUPABASE_URL || publicValue("SUPABASE_URL")).replace(/\/$/, "");
  const anon = process.env.TEST_SUPABASE_ANON_KEY || publicValue("SUPABASE_ANON_KEY");
  if (!base || !anon) throw new Error("Falta la URL pública en tools/simulator/config.js.");

  const email = process.env.TEST_EMAIL || await promptLine("Correo de la cuenta demo: ");
  const password = process.env.TEST_PASSWORD || await promptSecret("Contraseña (no se muestra): ");
  const fn = `${base}/functions/v1`;
  let jwt = "";

  async function request(url, { method = "GET", body, authenticated = false, timeoutMs = 0 } = {}) {
    const headers = { apikey: anon, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (authenticated) headers.Authorization = `Bearer ${jwt}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, data };
  }

  jwt = await signIn(request, `${base}/auth/v1`, email, password);
  const stallRes = await request(
    `${base}/rest/v1/stalls?id=eq.${PEY_STALL_ID}&select=id,provider,provider_account_ref`,
    { authenticated: true },
  );
  const stall = oneStall(stallRes.data);
  const allowed = stallAllowsCent(stall);
  if (stallRes.status !== 200 || !allowed.ok) {
    console.log(`El puesto no cumple provider=pey y provider_account_ref null (${stallRes.status}). No se crea la orden.`);
    process.exitCode = 1;
    return;
  }
  console.log("Puesto pey con provider_account_ref null. No se cambia PEY_LIVE_ENABLED ni se transfiere.");

  const orderStore = fileStore(ORDER_NAME);
  const savedId = orderStore.read()?.trim() || null;
  const publicUrl = `${fn}/public-orders?stallId=${PEY_STALL_ID}`;

  async function readOrder(orderId) {
    const merchant = await request(`${fn}/orders/${orderId}`, { authenticated: true });
    const pub = await request(publicUrl);
    return { merchant, pub };
  }

  async function poll(orderId) {
    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      const { merchant, pub } = await readOrder(orderId);
      const view = merchant.data;
      const listed = publicOrderById(pub.data, orderId);
      if (view?.state !== "PAID" && view?.secretWord && !orderHidesWord(listed)) {
        console.log("public-orders revela la palabra de esta orden antes de PAID.");
        process.exitCode = 1;
        return;
      }
      const decision = pollDecision(view, listed);
      console.log(`estado ${view?.state ?? merchant.status}`);
      if (decision.done) {
        console.log(decision.ok ? "PAID y la palabra pública coincide." : `La palabra pública no coincide (${decision.reason}).`);
        process.exitCode = decision.ok ? 0 : 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    console.log("Sigue sin PAID.");
    console.log(queryInstructions(base, orderId));
    process.exitCode = 2;
  }

  if (!args.create) {
    if (savedId) {
      const { merchant, pub } = await readOrder(savedId);
      const outcome = describeSavedOrder(merchant.data, pub.status, pub.data);
      console.log(`Orden guardada ${savedId}, estado ${merchant.data?.state ?? merchant.status}.`);
      if (outcome.kind === "paid") {
        console.log("PAID y la palabra pública coincide.");
        return;
      }
      if (outcome.kind === "tardia") {
        console.log("PAID tardío: la palabra de esta orden no está en public-orders.");
        return;
      }
      if (!outcome.ok) {
        console.log(outcome.kind === "filtracion"
          ? "public-orders revela la palabra de esta orden antes de PAID."
          : "La palabra pública no coincide.");
        process.exitCode = 1;
        return;
      }
      console.log("public-orders no revela la palabra de esta orden.");
    } else {
      console.log("No hay orden guardada. Solo lectura: no se llamó a POST /orders.");
    }
    if (args.wait && savedId) await poll(savedId);
    else if (args.wait) console.log("No hay orderId para consultar. No se crea la orden.");
    return;
  }

  if (!process.stdin.isTTY) throw new Error("La frase de confirmación se escribe en un terminal.");
  const phrase = await promptLine(`Escribe exactamente ${CONFIRM_PHRASE} para crear el QR: `);
  if (!mayCreateOrder({ createFlag: true, phrase, stall }).post) {
    console.log("Confirmación distinta. No se crea la orden.");
    return;
  }

  const keyStore = fileStore(KEY_NAME);
  const loaded = loadIdempotencyKey(keyStore, () => crypto.randomUUID());
  if (keyStore.read()?.trim() !== loaded.key) throw new Error("clave_no_guardada");
  const body = orderBody(loaded.key);
  if (body.amountCents !== AMOUNT_CENTS || body.method !== METHOD || body.stallId !== PEY_STALL_ID) {
    throw new Error("cuerpo_no_fijo");
  }

  let result;
  try {
    result = await request(`${fn}/orders`, { method: "POST", authenticated: true, body, timeoutMs: 45_000 });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    classifyCreateResult({ timedOut, networkError: !timedOut, status: 0, data: null });
    console.log(timedOut ? "La llamada expiró. La clave se conserva." : "La llamada no tuvo respuesta. La clave se conserva.");
    console.log(queryInstructions(base, savedId));
    console.log("Para recuperar la misma orden, vuelve a ejecutar con --crear. No borres la clave.");
    process.exitCode = 2;
    return;
  }

  const classified = classifyCreateResult(result);
  if (!classified.keepKey) throw new Error("clave");
  if (classified.orderId) {
    try {
      rememberOrderId(orderStore, classified.orderId);
    } catch (error) {
      console.log(error?.message === "orden_distinta"
        ? "La respuesta trae otra orden. No se continúa."
        : "No se pudo anotar la orden.");
      console.log(queryInstructions(base, savedId));
      process.exitCode = 2;
      return;
    }
  }
  if (classified.kind !== "ready") {
    const code = safeCode(result.data);
    console.log(classified.kind === "uncertain"
      ? `Respuesta incierta${code ? ` (${code})` : ""}. No se crea otra orden.`
      : `La orden no quedó lista${code ? ` (${code})` : ""}. La clave se conserva.`);
    console.log(queryInstructions(base, classified.orderId ?? savedId));
    process.exitCode = classified.kind === "uncertain" ? 2 : 1;
    return;
  }

  const order = result.data;
  const pub = await request(publicUrl);
  const payStore = fileStore(PAY_MARK_NAME);
  const decision = afterCreate(order, pub.status, pub.data, Date.now(), !!payStore.read()?.trim());
  if (!decision.keepKey) throw new Error("clave");
  if (!decision.invite) {
    if (decision.kind === "paid") console.log("PAID y la palabra pública coincide.");
    else if (decision.kind === "tardia") console.log("PAID tardío: la palabra de esta orden no está en public-orders.");
    else if (order.state === "PAID" && decision.kind === "palabra") console.log("La palabra pública no coincide. La clave se conserva.");
    else if (!decision.ok) console.log(`public-orders no autoriza el pago (${decision.kind}). La clave se conserva.`);
    else console.log(`Estado ${order.state}. No se pide el pago.`);
    console.log(queryInstructions(base, order.orderId));
    if (decision.kind === "paid" || decision.kind === "tardia") return;
    if (!decision.ok) {
      process.exitCode = 1;
      return;
    }
  } else {
    let claim;
    try { claim = claimPayPrompt(payStore); }
    catch {
      console.log("No se pudo guardar el marcador. No se pide el pago. La clave se conserva.");
      console.log(queryInstructions(base, order.orderId));
      process.exitCode = 2;
      return;
    }
    if (!claim.claimed) {
      console.log(`Estado ${order.state}. No se pide el pago.`);
      console.log(queryInstructions(base, order.orderId));
    } else {
      try {
        const loadedQr = await import("qrcode");
        const QRCode = loadedQr.default ?? loadedQr;
        const png = join(localDir, "qr.png");
        const svg = join(localDir, "qr.svg");
        await writeQrFiles(QRCode, { png, writeSvg: (text) => writeFileSync(svg, text) }, order.qrPayload);
        console.log(`QR local: ${png}`);
        console.log(`QR local: ${svg}`);
      } catch {
        console.log("No se pudo guardar el QR local. No se pide el pago. La clave se conserva.");
        console.log(queryInstructions(base, order.orderId));
        process.exitCode = 2;
        return;
      }
      console.log("Paga $0.01 MXN desde el banco. Este script no transfiere.");
      console.log("Cuando pagues: node tools/test/e2e_pey_remote.mjs --esperar");
    }
  }

  if (args.wait) await poll(order.orderId);
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked.toLowerCase() === import.meta.url.toLowerCase()) await main();
