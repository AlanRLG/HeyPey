// Contrato pey con HTTP y webhooks falsos. No llama a api.pey.mx ni usa dinero real.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmedReconcilePayment } from "../../backend/supabase/functions/_shared/reconcile_payment.ts";
import { centsToPesos, pesosToCents } from "../../backend/supabase/functions/_shared/providers/money.ts";
import { UncertainChargeError } from "../../backend/supabase/functions/_shared/charge_once.ts";
import { createPeyProvider, peyExpirationSeconds } from "../../backend/supabase/functions/_shared/providers/pey.ts";
import { signStandardWebhook } from "../../backend/supabase/functions/_shared/providers/standard_webhooks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = `whsec_${btoa("secreto-de-prueba-pey")}`;
const NOW = Date.parse("2026-11-15T18:00:00Z");

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
  assert.deepEqual(calls, ["/transaction/codi/qr/qr-falso", "/transaction/codi/qr/qr-falso"]);
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
    if (url.pathname === "/transaction/tx-hook") {
      return Response.json({
        id: "tx-hook",
        status: "PAID",
        amount: 240,
        payableType: "API_CODI_QR",
        payableId: "qr-1",
        metadata: { trackingKey: "RASTREO", externalMetadata: { orderId: "orden-1" } },
      });
    }
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
  assert.equal(await provider.getPayment("qr-1", { transactionId: "tx-otro-qr" }), null);
  const pending = await provider.getPayment("qr-1", { transactionId: "tx-pendiente" });
  assert.equal(pending, null);
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

test("el script de despliegue publica catalog y summary después de las migraciones", () => {
  const script = readFileSync(join(root, "tools/deploy/deploy_cloud.sh"), "utf8");
  const push = script.indexOf("supabase db push");
  const loop = script.indexOf("for f in orders webhooks reconcile mock-pay public-orders catalog summary;");
  assert.ok(push >= 0 && loop > push);
  assert.match(script, /^PEY_LIVE_ENABLED=false$/m);
  const claim = readFileSync(join(root, "backend/supabase/migrations/0007_charge_claim.sql"), "utf8");
  assert.match(claim, /claim_order_charge/);
  assert.match(readFileSync(join(root, "backend/supabase/migrations/0006_payment_integrity.sql"), "utf8"), /mark_order_paid/);
  for (const name of ["orders", "webhooks", "reconcile", "mock-pay", "public-orders", "catalog", "summary"]) {
    assert.equal(existsSync(join(root, "backend/supabase/functions", name, "index.ts")), true);
  }
});
