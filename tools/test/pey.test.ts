// Contrato pey con HTTP y webhooks falsos. No llama a api.pey.mx ni usa dinero real.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../../backend/supabase/functions/_shared/access.ts";
import { customerView, type OrderRow } from "../../backend/supabase/functions/_shared/orders.ts";
import { confirmedReconcilePayment } from "../../backend/supabase/functions/_shared/reconcile_payment.ts";
import { centsToPesos, pesosToCents } from "../../backend/supabase/functions/_shared/providers/money.ts";
import { UncertainChargeError } from "../../backend/supabase/functions/_shared/charge_once.ts";
import { acceptWebhookTarget } from "../../backend/supabase/functions/_shared/webhook_gate.ts";
import { settleWebhookPayment } from "../../backend/supabase/functions/_shared/webhook_settle.ts";
import {
  assessPeyTransaction,
  createPeyProvider,
  peyBankAccountId,
  PeyPaymentRejected,
  PeyUnavailable,
  peyExpirationSeconds,
} from "../../backend/supabase/functions/_shared/providers/pey.ts";
import { signStandardWebhook } from "../../backend/supabase/functions/_shared/providers/standard_webhooks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = `whsec_${btoa("secreto-de-prueba-pey")}`;
const NOW = Date.parse("2026-11-15T18:00:00Z");
const STALL_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STALL_B = "01BX5ZZKBKACT4V77H4H3YFQ2E";

function paidTransaction(over: Record<string, unknown> = {}) {
  return {
    id: "tx-hook",
    status: "PAID",
    amount: 240,
    payableType: "API_CODI_QR",
    payableId: "qr-1",
    paymentMethod: "CODI",
    currency: "MXN",
    metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
    ...over,
  };
}

function guardedFetch(
  handler: (url: URL, init: RequestInit) => Promise<Response> | Response,
) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const href = String(input);
    if (href.includes("api.pey.mx")) throw new Error("red real");
    calls.push(new URL(href).pathname);
    return handler(new URL(href), init ?? {});
  };
  return { fetchImpl, calls };
}

test("un centavo se convierte a 0.01 pesos", () => {
  assert.equal(centsToPesos(1), 0.01);
  assert.equal(JSON.stringify(centsToPesos(1)), "0.01");
  assert.equal(centsToPesos(24000), 240);
  assert.equal(pesosToCents(0.01), 1);
  assert.equal(pesosToCents(150), 15000);
  assert.equal(pesosToCents(240), 24000);
});

test("POST /codi/qr manda pesos y una expiración de al menos 360 s", async () => {
  const bodies: Record<string, unknown>[] = [];
  const { fetchImpl, calls } = guardedFetch((_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    const headers = new Headers(init.headers);
    assert.equal(headers.get("Authorization"), "Bearer test-key");
    return Response.json({ id: "qr-falso", qrString: "CODI|FALSO" }, { status: 201 });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const orderId = "11111111-1111-1111-1111-111111111111";
  const created = await provider.createCharge({
    orderId,
    amountCents: 1,
    expiresAt: new Date(NOW + 30_000).toISOString(),
    accountRef: null,
    concept: "Orden 7",
  });
  assert.deepEqual(calls, ["/codi/qr"]);
  assert.equal(bodies[0].amount, 0.01);
  assert.equal(bodies[0].expiration, 360);
  assert.equal(peyExpirationSeconds(new Date(NOW + 400_000).toISOString(), NOW), 400);
  assert.deepEqual(bodies[0].metadata, { orderId });
  assert.match(String(bodies[0].numRef), /^[0-9]{1,7}$/);
  assert.equal("bankAccountId" in bodies[0], false);
  assert.equal(created.chargeId, "qr-falso");
  assert.equal(created.qrPayload, "CODI|FALSO");
  assert.equal(Date.parse(created.expiresAt) - NOW, 360_000);

  await provider.createCharge({
    orderId,
    amountCents: 24000,
    expiresAt: new Date(NOW + 400_000).toISOString(),
    accountRef: null,
  });
  assert.equal(bodies[1].amount, 240);
  assert.equal(bodies[1].expiration, 400);
  assert.equal(calls.includes("/charges"), false);
});

test("GET /transaction/codi/qr pagina hasta el pago", async () => {
  const { fetchImpl, calls } = guardedFetch((url) => {
    if (url.pathname === "/transaction/tx-pagada") {
      return Response.json(paidTransaction({
        id: "tx-pagada",
        payableId: "qr-falso",
      }));
    }
    if (!url.searchParams.get("nextToken")) {
      return Response.json({
        items: [{ id: "pend", status: "PENDING", amount: 240 }],
        nextToken: "pagina-2",
      });
    }
    return Response.json({
      items: [{
        id: "tx-pagada",
        status: "PAID",
        amount: 240,
        metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
      }],
      nextToken: null,
    });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const payment = await provider.getPayment("qr-falso", { orderId: "orden-1", amountCents: 24000 });
  assert.deepEqual(calls, [
    "/transaction/codi/qr/qr-falso",
    "/transaction/codi/qr/qr-falso",
    "/transaction/tx-pagada",
  ]);
  assert.equal(payment?.transactionId, "tx-pagada");
  assert.equal(payment?.amountCents, 24000);
  assert.equal(payment?.chargeId, "qr-falso");
  assert.equal(payment?.reference, "orden-1");
  assert.equal(payment?.trackingKey, "RASTREO");
});

test("dos pagos en el mismo QR: el webhook solo confirma su transactionId", async () => {
  const paths: string[] = [];
  const { fetchImpl } = guardedFetch((url) => {
    paths.push(url.pathname);
    if (url.pathname === "/transaction/tx-hook") return Response.json(paidTransaction());
    if (url.pathname === "/transaction/tx-otro-qr") {
      return Response.json({
        id: "tx-otro-qr",
        status: "PAID",
        amount: 240,
        payableType: "API_CODI_QR",
        payableId: "qr-ajeno",
        metadata: { externalMetadata: { orderId: "orden-1" } },
      });
    }
    if (url.pathname === "/transaction/tx-pendiente") {
      return Response.json({
        id: "tx-pendiente",
        status: "PENDING",
        amount: 240,
        payableType: "API_CODI_QR",
        payableId: "qr-1",
        metadata: { externalMetadata: { orderId: "orden-1" } },
      });
    }
    return Response.json({
      items: [
        {
          id: "tx-otra",
          status: "PAID",
          amount: 240,
          metadata: { externalMetadata: { orderId: "otra-orden" } },
        },
        {
          id: "tx-hook",
          status: "PAID",
          amount: 240,
          metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
        },
      ],
      nextToken: null,
    });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const order = { id: "orden-1", amount_cents: 24000, provider_charge_id: "qr-1" };
  const hooked = await provider.getPayment("qr-1", { transactionId: "tx-hook", orderId: order.id, amountCents: 24000 });
  assert.deepEqual(paths, ["/transaction/tx-hook"]);
  assert.equal(hooked?.transactionId, "tx-hook");
  assert.equal(hooked?.chargeId, "qr-1");
  assert.equal(hooked?.amountCents, 24000);
  assert.equal(hooked?.reference, "orden-1");
  const decision = confirmedReconcilePayment(order, hooked, "tx-hook");
  assert.equal(decision.pay, true);
  assert.equal(decision.transactionId, "tx-hook");

  const firstPaid = {
    chargeId: "qr-1",
    transactionId: "tx-otra",
    amountCents: 24000,
    trackingKey: null,
    reference: "orden-1",
  };
  const wrong = confirmedReconcilePayment(order, firstPaid, "tx-hook");
  assert.equal(wrong.pay, false);
  assert.equal(wrong.reason, "transaction_mismatch");

  const reconciled = await provider.getPayment("qr-1", { orderId: "orden-1", amountCents: 24000 });
  assert.equal(reconciled?.transactionId, "tx-hook");
  assert.equal(paths.includes("/transaction/codi/qr/qr-1"), true);
  await assert.rejects(
    () => provider.getPayment("qr-1", { transactionId: "tx-otro-qr", orderId: "orden-1", amountCents: 24000 }),
    (error: unknown) => error instanceof PeyPaymentRejected && error.reason === "qr_mismatch",
  );
  await assert.rejects(
    () => provider.getPayment("qr-1", { transactionId: "tx-pendiente", orderId: "orden-1", amountCents: 24000 }),
    (error: unknown) => error instanceof PeyUnavailable,
  );
});

test("el webhook usa Standard Webhooks y rechaza x-signature", async () => {
  const body = JSON.stringify({
    type: "codi.qr.payment_received",
    amount: 150,
    codiQrId: "qr-falso",
    transactionId: "01TXFALSA",
    metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
  });
  const timestamp = Math.floor(NOW / 1000);
  const signature = await signStandardWebhook(SECRET, "msg_1", timestamp, body);
  const provider = createPeyProvider({
    live: false,
    webhookSecret: SECRET,
    now: () => NOW,
    fetch: async () => { throw new Error("no debe consultar la red"); },
  });
  const ok = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  }), body);
  assert.equal(ok?.status, "settled");
  assert.equal(ok?.eventId, "msg_1");
  assert.equal(ok?.chargeId, "qr-falso");
  assert.equal(ok?.transactionId, "01TXFALSA");
  assert.equal(ok?.amountCents, 15000);
  assert.equal(ok?.reference, "orden-1");
  assert.equal(ok?.trackingKey, "RASTREO");

  const tampered = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: {
      "webhook-id": "msg_1",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
      "x-signature": signature,
    },
  }), `${body} `);
  assert.equal(tampered, null);

  const legacy = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: { "x-signature": signature, "x-timestamp": String(timestamp) },
  }), body);
  assert.equal(legacy, null);
});

test("con el vivo apagado no hay red, y cancelar un QR no llama al proveedor", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("no");
  };
  const off = createPeyProvider({ live: false, fetch: fetchImpl, apiKey: "test-key", baseUrl: "http://127.0.0.1:9" });
  assert.equal("getStatus" in off, false);
  await assert.rejects(
    () => off.createCharge({ orderId: "o", amountCents: 100, expiresAt: new Date(NOW).toISOString(), accountRef: null }),
    /pey_live_disabled/,
  );
  await assert.rejects(
    () => off.getPayment("qr-falso", { transactionId: "tx", orderId: "orden-1", amountCents: 100 }),
    /pey_live_disabled/,
  );
  await assert.rejects(() => off.cancelCharge("qr-falso"), /pey_no_remote_cancel/);
  const on = createPeyProvider({ live: true, fetch: fetchImpl, apiKey: "test-key", baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(() => on.cancelCharge("qr-falso"), /pey_no_remote_cancel/);
  assert.equal(calls, 0);

  const failing = guardedFetch(() => new Response("no", { status: 500 }));
  const live = createPeyProvider({
    fetch: failing.fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  await assert.rejects(
    () => live.createCharge({ orderId: "o", amountCents: 100, expiresAt: new Date(NOW).toISOString(), accountRef: null }),
    (error: unknown) => error instanceof UncertainChargeError,
  );
  const rejected = guardedFetch(() => Response.json({ error: { type: "INVALID_AMOUNT" } }, { status: 400 }));
  const client = createPeyProvider({
    fetch: rejected.fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  await assert.rejects(
    () => client.createCharge({ orderId: "o", amountCents: 100, expiresAt: new Date(NOW).toISOString(), accountRef: null }),
    /pey_create_400/,
  );
});

test("cada puesto cobra a su cuenta pey y una CLABE no sale del servidor", async () => {
  const bodies: Record<string, unknown>[] = [];
  const { fetchImpl, calls } = guardedFetch((_url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ id: "qr-falso", qrString: "CODI|FALSO" }, { status: 201 });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    bankAccountId: STALL_B,
    now: () => NOW,
  });
  await provider.createCharge({
    orderId: "orden-a",
    amountCents: 100,
    expiresAt: new Date(NOW + 400_000).toISOString(),
    accountRef: STALL_A,
  });
  await provider.createCharge({
    orderId: "orden-b",
    amountCents: 100,
    expiresAt: new Date(NOW + 400_000).toISOString(),
    accountRef: null,
  });
  assert.equal(bodies[0].bankAccountId, STALL_A);
  assert.equal(bodies[1].bankAccountId, STALL_B);
  assert.equal(bodies[0].bankAccountId === bodies[1].bankAccountId, false);
  assert.equal(peyBankAccountId(null, null), null);
  const clabe = "012345678901234567";
  await assert.rejects(
    () => provider.createCharge({
      orderId: "orden-c",
      amountCents: 100,
      expiresAt: new Date(NOW).toISOString(),
      accountRef: clabe,
    }),
    /pey_account_ref_not_clabe/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.includes("/codi/qr"), true);
});

test("GET /transaction/{id} exige método, moneda, QR, monto y orden", () => {
  const expected = { transactionId: "tx-hook", chargeId: "qr-1", orderId: "orden-1", amountCents: 24000 };
  assert.equal(assessPeyTransaction(paidTransaction(), expected).ok, true);
  for (const [field, value, reason] of [
    ["paymentMethod", "CARD", "method_mismatch"],
    ["currency", "USD", "currency_mismatch"],
    ["payableType", "API_CODI_PN", "payable_type_mismatch"],
    ["payableId", "qr-ajeno", "qr_mismatch"],
    ["amount", 150, "amount_mismatch"],
    ["id", "tx-otra", "transaction_mismatch"],
  ] as const) {
    const row = paidTransaction({ [field]: value });
    const result = assessPeyTransaction(row, expected);
    assert.equal(result.ok, false, field);
    if (!result.ok) assert.equal(result.reason, reason);
  }
  const missingOrder = paidTransaction({ metadata: { trackingKey: "RASTREO" } });
  const missing = assessPeyTransaction(missingOrder, expected);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, "reference_mismatch");
  const pending = assessPeyTransaction(paidTransaction({ status: "PENDING" }), expected);
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.kind, "unavailable");
});

test("el webhook sin orderId se confirma solo con el GET, y una referencia contraria no paga", async () => {
  const order = { id: "orden-1", amount_cents: 24000, provider: "pey", provider_charge_id: "qr-1" };
  const withoutRef = acceptWebhookTarget("pey", {
    chargeId: "qr-1",
    reference: "",
    amountCents: 24000,
    transactionId: "tx-hook",
  }, order);
  assert.equal(withoutRef.ok, true);
  const contradicted = acceptWebhookTarget("pey", {
    chargeId: "qr-1",
    reference: "otra-orden",
    amountCents: 24000,
    transactionId: "tx-hook",
  }, order);
  assert.equal(contradicted.ok, false);
  if (!contradicted.ok) assert.equal(contradicted.reason, "ref_mismatch");

  let fetches = 0;
  const { fetchImpl } = guardedFetch((url) => {
    fetches += 1;
    if (url.pathname === "/transaction/tx-hook") return Response.json(paidTransaction());
    return new Response("no", { status: 404 });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    webhookSecret: SECRET,
    now: () => NOW,
  });
  const body = JSON.stringify({
    type: "codi.qr.payment_received",
    amount: 240,
    codiQrId: "qr-1",
    transactionId: "tx-hook",
  });
  const timestamp = Math.floor(NOW / 1000);
  const signature = await signStandardWebhook(SECRET, "msg_sin_meta", timestamp, body);
  const event = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: {
      "webhook-id": "msg_sin_meta",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  }), body);
  assert.equal(fetches, 0);
  assert.equal(event?.status, "settled");
  assert.equal(event?.reference, "");
  assert.equal(event?.eventId, "msg_sin_meta");
  const again = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: {
      "webhook-id": "msg_sin_meta",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  }), body);
  assert.equal(again?.eventId, event?.eventId);
  const payment = await provider.getPayment("qr-1", { transactionId: "tx-hook", orderId: "orden-1", amountCents: 24000 });
  const decision = confirmedReconcilePayment(order, payment, "tx-hook");
  assert.equal(decision.pay, true);
  assert.equal(decision.eventId, "reconcile:tx-hook");
  assert.equal(confirmedReconcilePayment(order, payment, "tx-hook").eventId, decision.eventId);
  await assert.rejects(
    () => provider.getPayment("qr-1", { transactionId: "tx-ausente", orderId: "orden-1", amountCents: 24000 }),
    (error: unknown) => error instanceof PeyUnavailable && /404/.test(error.message),
  );
  const waiting = customerView({
    id: "orden-1",
    stall_id: "s",
    number: 1,
    amount_cents: 24000,
    method: "codi",
    state: "PENDING_UNKNOWN",
    secret_word: "tortuga",
    qr_payload: "CODI|FALSO",
    expires_at: null,
    paid_at: null,
    late_payment: false,
    items: [],
    provider: "pey",
    provider_charge_id: "qr-1",
    created_at: "2026-11-15T18:00:00Z",
  } satisfies OrderRow);
  assert.equal(waiting.secretWord, null);
});

test("un error de pey no devuelve la clave, el secreto ni una CLABE", async () => {
  const secretBody = {
    error: { message: "Bearer test-key whsec_prueba 012345678901234567" },
  };
  const { fetchImpl } = guardedFetch(() => Response.json(secretBody, { status: 400 }));
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const error = await provider.createCharge({
    orderId: "orden-1",
    amountCents: 100,
    expiresAt: new Date(NOW).toISOString(),
    accountRef: null,
  }).catch((caught: unknown) => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "pey_create_400");
  assert.equal(error.message.includes("012345678901234567"), false);
  assert.equal(error.message.includes("whsec_"), false);
  const redacted = redactSecrets("Bearer test-key whsec_prueba 012345678901234567");
  assert.equal(redacted.includes("012345678901234567"), false);
  assert.equal(redacted.includes("whsec_prueba"), false);
  assert.equal(redacted.includes("test-key"), false);
});

test("el script de despliegue publica catalog y summary después de las migraciones", () => {
  const script = readFileSync(join(root, "tools/deploy/deploy_cloud.sh"), "utf8");
  const push = script.indexOf("supabase db push");
  const loop = script.indexOf("for f in orders webhooks reconcile mock-pay public-orders catalog summary;");
  assert.ok(push >= 0 && loop > push);
  assert.match(script, /^PEY_LIVE_ENABLED=false$/m);
  assert.match(script, /cron\.schedule\('reconcile-orders', '\* \* \* \* \*'/);
  const config = readFileSync(join(root, "backend/supabase/config.toml"), "utf8");
  assert.match(config, /\[functions\.webhooks\]\s+verify_jwt = false/);
  assert.match(config, /\[functions\.reconcile\]\s+verify_jwt = false/);
  const claim = readFileSync(join(root, "backend/supabase/migrations/0007_charge_claim.sql"), "utf8");
  assert.match(claim, /claim_order_charge/);
  assert.match(readFileSync(join(root, "backend/supabase/migrations/0006_payment_integrity.sql"), "utf8"), /mark_order_paid/);
  for (const name of ["orders", "webhooks", "reconcile", "mock-pay", "public-orders", "catalog", "summary"]) {
    assert.equal(existsSync(join(root, "backend/supabase/functions", name, "index.ts")), true);
  }
});

test("un PENDING no oculta un PAID posterior de la misma orden", async () => {
  const pending = {
    id: "tx-espera",
    status: "PENDING",
    amount: 240,
    metadata: { externalMetadata: { orderId: "orden-1" } },
  };
  const paid = {
    id: "tx-pagada",
    status: "PAID",
    amount: 240,
    metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
  };
  const samePage = guardedFetch((url) => {
    if (url.pathname === "/transaction/tx-pagada") {
      return Response.json(paidTransaction({ id: "tx-pagada" }));
    }
    return Response.json({ items: [pending, paid], nextToken: null });
  });
  const same = createPeyProvider({
    fetch: samePage.fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const onPage = await same.getPayment("qr-1", { orderId: "orden-1", amountCents: 24000 });
  assert.equal(onPage?.transactionId, "tx-pagada");
  assert.deepEqual(samePage.calls, ["/transaction/codi/qr/qr-1", "/transaction/tx-pagada"]);

  const nextPage = guardedFetch((url) => {
    if (url.pathname === "/transaction/tx-pagada") {
      return Response.json(paidTransaction({ id: "tx-pagada" }));
    }
    if (!url.searchParams.get("nextToken")) {
      return Response.json({ items: [pending], nextToken: "pagina-2" });
    }
    return Response.json({ items: [paid], nextToken: null });
  });
  const later = createPeyProvider({
    fetch: nextPage.fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    now: () => NOW,
  });
  const onNext = await later.getPayment("qr-1", { orderId: "orden-1", amountCents: 24000 });
  assert.equal(onNext?.transactionId, "tx-pagada");
  assert.equal(onNext?.amountCents, 24000);
  assert.deepEqual(nextPage.calls, [
    "/transaction/codi/qr/qr-1",
    "/transaction/codi/qr/qr-1",
    "/transaction/tx-pagada",
  ]);
});

test("el webhook sin orderId envía a la RPC la orden que confirmó el GET", async () => {
  const order = { id: "orden-1", amount_cents: 24000, provider: "pey", provider_charge_id: "qr-1" };
  const { fetchImpl, calls } = guardedFetch((url) => {
    if (url.pathname === "/transaction/tx-hook") return Response.json(paidTransaction());
    return new Response("no", { status: 404 });
  });
  const provider = createPeyProvider({
    fetch: fetchImpl,
    live: true,
    baseUrl: "http://127.0.0.1:9",
    apiKey: "test-key",
    webhookSecret: SECRET,
    now: () => NOW,
  });
  const body = JSON.stringify({
    type: "codi.qr.payment_received",
    amount: 240,
    codiQrId: "qr-1",
    transactionId: "tx-hook",
  });
  const timestamp = Math.floor(NOW / 1000);
  const signature = await signStandardWebhook(SECRET, "msg_sin_orden", timestamp, body);
  const event = await provider.verifyWebhook(new Request("http://127.0.0.1/webhooks/pey", {
    headers: {
      "webhook-id": "msg_sin_orden",
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature,
    },
  }), body);
  assert.ok(event);
  assert.equal(event.reference, "");
  const settled = await settleWebhookPayment({
    providerName: "pey",
    event,
    order,
    getPayment: (chargeId, selector) => provider.getPayment(chargeId, selector),
    payload: { transactionId: "tx-hook", codiQrId: "qr-1" },
  });
  assert.equal(settled.outcome, "pay");
  if (settled.outcome !== "pay") return;
  assert.equal(settled.rpc.p_order_id, order.id);
  assert.notEqual(settled.rpc.p_order_id, event.reference);
  assert.equal(settled.rpc.p_provider, "pey");
  assert.equal(settled.rpc.p_event_id, "msg_sin_orden");
  assert.equal(settled.rpc.p_charge_id, "qr-1");
  assert.equal(settled.rpc.p_transaction_id, "tx-hook");
  assert.equal(settled.rpc.p_amount_cents, 24000);
  assert.deepEqual(calls, ["/transaction/tx-hook"]);
  const handler = readFileSync(join(root, "backend/supabase/functions/webhooks/index.ts"), "utf8");
  assert.equal(handler.includes("p_order_id: event.reference"), false);
  assert.match(handler, /db\.rpc\("mark_order_paid", settled\.rpc\)/);
});
