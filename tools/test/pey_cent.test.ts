// La prueba de un centavo no llama a la red. Comprueba que el modo normal no crea
// órdenes y que la clave guardada se reutiliza.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import {
  AMOUNT_CENTS,
  CONFIRM_PHRASE,
  METHOD,
  PEY_STALL_ID,
  classifyCreateResult,
  loadIdempotencyKey,
  mayCreateOrder,
  orderBody,
  parseArgs,
  afterCreate,
  claimPayPrompt,
  describeSavedOrder,
  orderHidesWord,
  pollDecision,
  readyToPay,
  rememberOrderId,
  stallAllowsCent,
  writeQrFiles,
} from "./pey_cent.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const goodStall = { id: PEY_STALL_ID, provider: "pey", provider_account_ref: null };

function memoryFs(initial: string | null = null) {
  let text = initial;
  const writes: string[] = [];
  return {
    writes,
    read: () => text,
    write(value: string) {
      if (text != null) {
      const error = new Error("exists") as Error & { code: string };
      error.code = "EEXIST";
        throw error;
      }
      text = value;
      writes.push(value);
    },
  };
}

test("sin --crear no hay orden, aunque la frase y el puesto sean válidos", () => {
  assert.deepEqual(parseArgs([]), { create: false, wait: false });
  assert.deepEqual(parseArgs(["--esperar"]), { create: false, wait: true });
  const decision = mayCreateOrder({ createFlag: false, phrase: CONFIRM_PHRASE, stall: goodStall });
  assert.equal(decision.post, false);
  assert.equal(decision.reason, "lectura");
  assert.equal(mayCreateOrder({ createFlag: true, phrase: "si", stall: goodStall }).post, false);
  assert.equal(mayCreateOrder({
    createFlag: true,
    phrase: CONFIRM_PHRASE,
    stall: { ...goodStall, provider: "mock" },
  }).post, false);
  assert.equal(mayCreateOrder({
    createFlag: true,
    phrase: CONFIRM_PHRASE,
    stall: { ...goodStall, provider_account_ref: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  }).post, false);
  assert.equal(stallAllowsCent({ provider: "pey" }).ok, false);
  assert.equal(mayCreateOrder({ createFlag: true, phrase: CONFIRM_PHRASE, stall: goodStall }).post, true);
});

test("la clave de un centavo se escribe una vez y el reintento usa la misma", () => {
  const fs = memoryFs();
  let generated = 0;
  const first = loadIdempotencyKey(fs, () => {
    generated += 1;
    return "clave-centavo-0001";
  });
  assert.equal(first.reused, false);
  assert.equal(first.key, "clave-centavo-0001");
  assert.deepEqual(fs.writes, ["clave-centavo-0001\n"]);
  const body = orderBody(first.key);
  assert.equal(body.amountCents, 1);
  assert.equal(body.amountCents, AMOUNT_CENTS);
  assert.equal(body.method, METHOD);
  assert.equal(body.stallId, PEY_STALL_ID);
  assert.equal(body.idempotencyKey, first.key);

  const second = loadIdempotencyKey(fs, () => {
    generated += 1;
    return "clave-distinta-0002";
  });
  assert.equal(second.reused, true);
  assert.equal(second.key, first.key);
  assert.equal(generated, 1);
  assert.equal(fs.writes.length, 1);

  let reads = 0;
  const kept = loadIdempotencyKey({
    read() {
      reads += 1;
      return reads === 1 ? null : "clave-ya-anotada\n";
    },
    write() {
      const error = new Error("exists") as Error & { code: string };
      error.code = "EEXIST";
      throw error;
    },
  }, () => "clave-nueva-que-no-sale");
  assert.equal(kept.key, "clave-ya-anotada");
  assert.equal(kept.reused, true);
});

test("un timeout conserva la clave y no deja lista otra orden", () => {
  const fs = memoryFs();
  const loaded = loadIdempotencyKey(fs, () => "clave-centavo-0001");
  const outcome = classifyCreateResult({ timedOut: true, networkError: false, status: 0, data: null });
  assert.equal(outcome.kind, "uncertain");
  assert.equal(outcome.keepKey, true);
  assert.equal(outcome.orderId, null);
  const again = loadIdempotencyKey(fs, () => "no-debe-usarse");
  assert.equal(again.key, loaded.key);

  const held = classifyCreateResult({
    timedOut: false,
    networkError: false,
    status: 502,
    data: { error: "provider_error", orderId: "343eff54-061f-434c-b0fd-2611c058092d" },
  });
  assert.equal(held.kind, "uncertain");
  assert.equal(held.keepKey, true);
  assert.equal(held.orderId, "343eff54-061f-434c-b0fd-2611c058092d");
  assert.equal(typeof held.orderId, "string");
  assert.throws(() => rememberOrderId(memoryFs("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n"), held.orderId ?? ""), /orden_distinta/);

  const ready = classifyCreateResult({
    timedOut: false,
    networkError: false,
    status: 201,
    data: { orderId: held.orderId, amountCents: 1, method: "codi", state: "AWAITING_PAYMENT" },
  });
  assert.equal(ready.kind, "ready");
  assert.equal(orderHidesWord({ orderId: held.orderId, secretWord: null }), true);
  assert.equal(orderHidesWord({ secretWord: "tortuga" }), false);
  assert.equal(pollDecision(
    { state: "PAID", latePayment: false, secretWord: "tortuga" },
    { state: "PAID", secretWord: "tortuga" },
  ).ok, true);
  assert.equal(pollDecision(
    { state: "AWAITING_PAYMENT", secretWord: "tortuga" },
    { state: "AWAITING_PAYMENT", secretWord: null },
  ).done, false);
  assert.equal(readyToPay({
    amountCents: 1,
    method: "codi",
    secretWord: "tortuga",
    qrPayload: "CODI|PRUEBA",
    state: "AWAITING_PAYMENT",
    expiresAt: "2099-01-01T00:00:00Z",
  }, Date.parse("2026-11-15T18:00:00Z")), true);
});

const ORDER_ID = "343eff54-061f-434c-b0fd-2611c058092d";
const OTHER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = Date.parse("2026-11-15T18:00:00Z");

function awaitingOrder() {
  return {
    orderId: ORDER_ID,
    state: "AWAITING_PAYMENT",
    amountCents: 1,
    method: "codi",
    secretWord: "tortuga",
    qrPayload: "CODI|VIGENTE",
    expiresAt: "2026-11-15T18:10:00Z",
  };
}

function publicList(order) {
  return { orders: [order] };
}

test("una orden PAID muestra su palabra y no cuenta como filtración", () => {
  const merchant = { orderId: ORDER_ID, state: "PAID", latePayment: false, secretWord: "tortuga" };
  const payload = {
    orders: [
      { orderId: OTHER_ID, state: "PAID", secretWord: "tortuga", amountCents: 24000 },
      { orderId: ORDER_ID, state: "PAID", secretWord: "tortuga", amountCents: 1 },
    ],
  };
  const paid = describeSavedOrder(merchant, 200, payload);
  assert.equal(paid.ok, true);
  assert.equal(paid.kind, "paid");

  const waiting = describeSavedOrder(
    { ...merchant, state: "AWAITING_PAYMENT" },
    200,
    {
      orders: [
        { orderId: OTHER_ID, secretWord: "tortuga", amountCents: 1 },
        { orderId: ORDER_ID, secretWord: null, amountCents: 1, state: "AWAITING_PAYMENT" },
      ],
    },
  );
  assert.equal(waiting.ok, true);
  assert.equal(waiting.kind, "oculta");

  const leaked = describeSavedOrder(
    { ...merchant, state: "AWAITING_PAYMENT" },
    200,
    publicList({ orderId: ORDER_ID, secretWord: "tortuga", amountCents: 1 }),
  );
  assert.equal(leaked.ok, false);
  assert.equal(leaked.kind, "filtracion");
});

test("el pago se indica una sola vez y no en un estado cerrado", () => {
  const order = awaitingOrder();
  const listed = publicList({ orderId: ORDER_ID, amountCents: 1, secretWord: null, state: "AWAITING_PAYMENT" });
  const fs = memoryFs();
  const first = afterCreate(order, 200, listed, NOW, !!fs.read()?.trim());
  assert.equal(first.invite, true);
  const claim = claimPayPrompt(fs);
  assert.equal(claim.claimed, true);
  assert.equal(fs.read()?.trim(), "shown");
  const again = afterCreate(order, 200, listed, NOW, !!fs.read()?.trim());
  assert.equal(again.invite, false);
  assert.equal(again.kind, "ya_mostrado");

  for (const state of ["PENDING_UNKNOWN", "PAID", "CANCELLED", "EXPIRED"]) {
    const closed = afterCreate({ ...order, state, latePayment: false, secretWord: "tortuga" }, 200, {
      orders: [{ orderId: ORDER_ID, state, secretWord: state === "PAID" ? "tortuga" : null, amountCents: 1 }],
    }, NOW, false);
    assert.equal(closed.invite, false, state);
  }
  const stale = afterCreate({ ...order, expiresAt: "2026-11-15T17:00:00Z" }, 200, listed, NOW, false);
  assert.equal(stale.invite, false);
  assert.equal(stale.kind, "qr_vencido");
});

test("sin public-orders válido no se invita a pagar y la clave sigue", () => {
  const order = awaitingOrder();
  const http = afterCreate(order, 500, null, NOW, false);
  assert.equal(http.invite, false);
  assert.equal(http.ok, false);
  assert.equal(http.keepKey, true);
  assert.equal(http.kind, "public_http");

  const missing = afterCreate(order, 200, { orders: [{ orderId: OTHER_ID, amountCents: 1, secretWord: null }] }, NOW, false);
  assert.equal(missing.invite, false);
  assert.equal(missing.kind, "ausente");
  assert.equal(missing.keepKey, true);

  const amount = afterCreate(order, 200, publicList({ orderId: ORDER_ID, amountCents: 2, secretWord: null }), NOW, false);
  assert.equal(amount.invite, false);
  assert.equal(amount.kind, "monto");

  const visible = afterCreate(order, 200, publicList({ orderId: ORDER_ID, amountCents: 1, secretWord: "tortuga" }), NOW, false);
  assert.equal(visible.invite, false);
  assert.equal(visible.kind, "palabra");

  const fs = memoryFs("clave-centavo-0001\n");
  assert.equal(loadIdempotencyKey(fs, () => "otra-clave").key, "clave-centavo-0001");
  assert.equal(http.keepKey, true);
});

test("el QR de prueba se escribe en PNG y SVG sin salir de la máquina", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pey-qr-"));
  try {
    const png = join(dir, "qr.png");
    const svgPath = join(dir, "qr.svg");
    await writeQrFiles(QRCode, {
      png,
      writeSvg: async (text: string) => {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(svgPath, text);
      },
    }, "CODI|PRUEBA|NO-ES-UN-COBRO");
    const pngBytes = readFileSync(png);
    assert.equal(pngBytes.subarray(0, 4).toString("hex"), "89504e47");
    assert.match(readFileSync(svgPath, "utf8"), /<svg/);
    assert.equal(pngBytes.includes(Buffer.from("api.qrserver.com")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("el script real no crea órdenes en su rama de lectura y no finge el pago", () => {
  const source = readFileSync(join(here, "e2e_pey_remote.mjs"), "utf8");
  assert.match(source, /mayCreateOrder/);
  assert.match(source, /loadIdempotencyKey/);
  assert.match(source, /PEY_STALL_ID/);
  assert.equal(source.includes("/mock-pay"), false);
  assert.equal(source.includes("webhooks/"), false);
  assert.equal(source.includes("PEY_LIVE_ENABLED=true"), false);
  assert.equal(source.includes("api.qrserver.com"), false);
  assert.equal(source.includes("chart.googleapis.com"), false);
  assert.match(source, /if \(!args\.create\)/);
  assert.match(source, /describeSavedOrder/);
  assert.match(source, /afterCreate/);
  const claimAt = source.indexOf("claimPayPrompt");
  const payAt = source.indexOf("Paga $0.01");
  assert.ok(claimAt >= 0 && payAt > claimAt);
  assert.equal(source.split("Paga $0.01").length, 2);
  const ignore = readFileSync(join(here, "../../.gitignore"), "utf8");
  assert.match(ignore, /tools\/test\/\.pey-cent\//);
});
