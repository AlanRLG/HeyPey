// Pruebas del backend Mock sin Supabase ni red.
//   cd tools/test && npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { itemsError, parseCatalogBody } from "../../backend/supabase/functions/_shared/items.ts";
import { ACTIVE_STATES, customerView, merchantView, type OrderRow } from "../../backend/supabase/functions/_shared/orders.ts";
import { signMockPayloadWithSecret, verifyMockSignature } from "../../backend/supabase/functions/_shared/providers/mock_sign.ts";
import { canTakeChargeClaim, createChargeOnce, UncertainChargeError, type ChargeDraft, type CreatedCharge } from "../../backend/supabase/functions/_shared/charge_once.ts";
import { backoffMs, reconcileAction } from "../../backend/supabase/functions/_shared/reconcile_policy.ts";
import { confirmedReconcilePayment } from "../../backend/supabase/functions/_shared/reconcile_payment.ts";
import { buildSummary, mexicoCityDay, type SummaryOrder } from "../../backend/supabase/functions/_shared/summary.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SECRET = "secreto-de-prueba";

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "o",
    stall_id: "s",
    number: 7,
    amount_cents: 24000,
    method: "codi",
    state: "AWAITING_PAYMENT",
    secret_word: "tortuga",
    qr_payload: "QR",
    expires_at: null,
    paid_at: null,
    late_payment: false,
    items: [],
    provider: "mock",
    provider_charge_id: "ch",
    created_at: "2026-11-15T12:00:00Z",
    ...over,
  };
}

test("la vista pública oculta la palabra hasta un PAID que no sea tardío", () => {
  assert.equal(customerView(order()).secretWord, null);
  assert.equal(customerView(order({ state: "PAID" })).secretWord, "tortuga");
  assert.equal(customerView(order({ state: "PAID", late_payment: true })).secretWord, null);
  assert.equal(merchantView(order({ state: "PAID", late_payment: true })).secretWord, "tortuga");
  assert.equal(merchantView(order({ state: "PAID", late_payment: true })).latePayment, true);
});

test("una orden PAID no está entre las que se pueden cancelar", () => {
  for (const state of ["PAID", "PAID_CASH", "CANCELLED", "EXPIRED", "FAILED"]) {
    assert.equal(ACTIVE_STATES.includes(state), false, state);
  }
});

test("firma mock: válida, alterada, tarde o vacía", async () => {
  const body = JSON.stringify({ eventId: "e1", amountCents: 100 });
  const now = Date.parse("2026-11-15T18:00:00Z");
  const sig = await signMockPayloadWithSecret(SECRET, body, Math.floor(now / 1000));
  assert.equal(await verifyMockSignature(SECRET, sig, body, now), true);
  assert.equal(await verifyMockSignature(SECRET, sig, body + " ", now), false);
  assert.equal(await verifyMockSignature("otra", sig, body, now), false);
  assert.equal(await verifyMockSignature(SECRET, sig, body, now + 301_000), false);
  assert.equal(await verifyMockSignature(SECRET, "", body, now), false);
});

test("ítems y catálogo rechazan formas inválidas", () => {
  assert.equal(itemsError([]), null);
  assert.equal(itemsError([{ product: "diezmillo", qty: 1, unit: "kg" }]), null);
  assert.equal(itemsError([{}]), "items");
  assert.equal(itemsError([{ name: "x", amountCents: -1 }]), "items");
  assert.equal(itemsError("no"), "items");
  const ok = parseCatalogBody({ stallId: "stall-1234", name: "pechuga", priceCents: 14000, aliases: ["pollo"] });
  assert.equal("items" in ok && ok.items[0].priceCents, 14000);
  assert.equal("error" in parseCatalogBody({ stallId: "stall-1234", name: "x", priceCents: 1.5 }), true);
});

test("el corte suma CoDi y efectivo, y aparta tardíos y alertas", () => {
  const rows: SummaryOrder[] = [
    { id: "a", number: 1, method: "codi", state: "PAID", amount_cents: 1000, late_payment: false, reconcile_alerted_at: null },
    { id: "b", number: 2, method: "codi", state: "PAID", amount_cents: 2500, late_payment: true, reconcile_alerted_at: null },
    { id: "c", number: 3, method: "cash", state: "PAID_CASH", amount_cents: 500, late_payment: false, reconcile_alerted_at: null },
    { id: "d", number: 4, method: "codi", state: "CANCELLED", amount_cents: 9000, late_payment: false, reconcile_alerted_at: null },
    { id: "e", number: 5, method: "codi", state: "PENDING_UNKNOWN", amount_cents: 800, late_payment: false, reconcile_alerted_at: "2026-11-15T18:00:00Z" },
  ];
  const summary = buildSummary("s", "2026-11-15", rows);
  assert.deepEqual(summary.codi, { count: 2, amountCents: 3500 });
  assert.deepEqual(summary.cash, { count: 1, amountCents: 500 });
  assert.equal(summary.latePayments, 1);
  assert.equal(summary.pending, 1);
  assert.deepEqual(summary.alerts, [{ orderId: "e", number: 5, alertedAt: "2026-11-15T18:00:00Z" }]);
});

test("el corte cuenta las órdenes que aún no se cobraron", () => {
  const rows: SummaryOrder[] = [
    { id: "a", number: 1, method: "codi", state: "CREATING", amount_cents: 100, late_payment: false, reconcile_alerted_at: null },
    { id: "b", number: 2, method: "codi", state: "AWAITING_PAYMENT", amount_cents: 200, late_payment: false, reconcile_alerted_at: null },
    { id: "c", number: 3, method: "codi", state: "PENDING_UNKNOWN", amount_cents: 300, late_payment: false, reconcile_alerted_at: null },
    { id: "d", number: 4, method: "codi", state: "PAID", amount_cents: 400, late_payment: false, reconcile_alerted_at: null },
    { id: "e", number: 5, method: "cash", state: "PAID_CASH", amount_cents: 500, late_payment: false, reconcile_alerted_at: null },
    { id: "f", number: 6, method: "codi", state: "EXPIRED", amount_cents: 600, late_payment: false, reconcile_alerted_at: null },
  ];
  assert.equal(buildSummary("s", "2026-11-15", rows).pending, 3);
});

test("un pago settled con otro monto no marca la orden", () => {
  const order = { id: "orden-1", amount_cents: 24000, provider_charge_id: "qr-1" };
  const mismatch = confirmedReconcilePayment(order, {
    chargeId: "qr-1",
    transactionId: "tx-real",
    amountCents: 100,
    trackingKey: "tx-real",
    reference: "orden-1",
  });
  assert.equal(mismatch.pay, false);
  assert.equal(mismatch.reason, "amount_mismatch");
  assert.equal(mismatch.amountCents, 100);
  assert.equal(mismatch.eventId, undefined);
  const match = confirmedReconcilePayment(order, {
    chargeId: "qr-1",
    transactionId: "tx-real",
    amountCents: 24000,
    trackingKey: "TRACK",
    reference: "orden-1",
  });
  assert.equal(match.pay, true);
  assert.equal(match.amountCents, 24000);
  assert.equal(match.transactionId, "tx-real");
  assert.equal(match.eventId, "reconcile:tx-real");
});

test("dos solicitudes simultáneas crean un solo QR", async () => {
  const row: ChargeDraft = {
    id: "o",
    state: "CREATING",
    provider_charge_id: null,
    qr_payload: null,
    expires_at: "2026-11-15T18:03:00Z",
  };
  let claimToken: string | null = null;
  let creates = 0;
  const store = {
    claim(token: string) {
      if (claimToken && claimToken !== token) return Promise.resolve(null);
      claimToken = token;
      return Promise.resolve({ ...row });
    },
    read() { return Promise.resolve({ ...row }); },
    attach(token: string, charge: CreatedCharge) {
      if (claimToken !== token) return Promise.resolve(null);
      row.state = "AWAITING_PAYMENT";
      row.provider_charge_id = charge.chargeId;
      row.qr_payload = charge.qrPayload;
      row.expires_at = charge.expiresAt;
      return Promise.resolve({ ...row });
    },
    fail() { return Promise.resolve(); },
  };
  const create = async () => {
    creates += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { chargeId: "only", qrPayload: "QR-only", expiresAt: row.expires_at! };
  };
  const [first, second] = await Promise.all([
    createChargeOnce(store, create, { token: "token-aaaa" }),
    createChargeOnce(store, create, { token: "token-bbbb" }),
  ]);
  assert.equal(creates, 1);
  assert.equal("provider_charge_id" in first && first.provider_charge_id, "only");
  assert.equal("provider_charge_id" in second && second.provider_charge_id, "only");
  assert.equal("qr_payload" in first && first.qr_payload, "QR-only");
});

test("una llamada de más de 30 s no autoriza un segundo QR", async () => {
  let now = 1_000;
  let creates = 0;
  let fails = 0;
  const held = { token: null as string | null, claimedAtMs: null as number | null };
  const row: ChargeDraft = {
    id: "o",
    state: "CREATING",
    provider_charge_id: null,
    qr_payload: null,
    expires_at: "2026-11-15T18:03:00Z",
  };
  const store = {
    claim(token: string) {
      if (!canTakeChargeClaim(held, token, now)) return Promise.resolve(null);
      held.token = token;
      held.claimedAtMs = now;
      row.state = "CREATING";
      return Promise.resolve({ ...row });
    },
    read() { return Promise.resolve({ ...row }); },
    attach(token: string, charge: CreatedCharge) {
      if (held.token !== token) return Promise.resolve(null);
      row.state = "AWAITING_PAYMENT";
      row.provider_charge_id = charge.chargeId;
      row.qr_payload = charge.qrPayload;
      held.token = null;
      return Promise.resolve({ ...row });
    },
    fail() {
      fails += 1;
      row.state = "FAILED";
      held.token = null;
      return Promise.resolve();
    },
  };
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = createChargeOnce(store, async () => {
    creates += 1;
    now += 31_000;
    await gate;
    return { chargeId: "qr-lento", qrPayload: "QR-lento", expiresAt: row.expires_at! };
  }, { token: "token-aaaa", sleep: async () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(creates, 1);
  assert.equal(now, 32_000);
  assert.equal(canTakeChargeClaim(held, "token-bbbb", now), false);
  const second = await createChargeOnce(store, async () => {
    creates += 1;
    return { chargeId: "qr-extra", qrPayload: "QR-extra", expiresAt: row.expires_at! };
  }, { token: "token-bbbb", attempts: 1, sleep: async () => {} });
  assert.equal(creates, 1);
  assert.equal("error" in second && second.error, "in_progress");
  release();
  const done = await slow;
  assert.equal(fails, 0);
  assert.equal("provider_charge_id" in done && done.provider_charge_id, "qr-lento");

  creates = 0;
  fails = 0;
  held.token = null;
  row.provider_charge_id = null;
  row.qr_payload = null;
  row.state = "CREATING";
  const uncertain = await createChargeOnce(store, async () => {
    creates += 1;
    now += 31_000;
    throw new UncertainChargeError("pey_create_uncertain");
  }, { token: "token-cccc" });
  assert.equal("error" in uncertain && uncertain.error, "charge_uncertain");
  assert.equal(fails, 0);
  assert.equal(held.token, "token-cccc");
  const retry = await createChargeOnce(store, async () => {
    creates += 1;
    return { chargeId: "qr-extra", qrPayload: "QR-extra", expiresAt: row.expires_at! };
  }, { token: "token-dddd", attempts: 1, sleep: async () => {} });
  assert.equal(creates, 1);
  assert.equal("error" in retry && retry.error, "in_progress");
});

test("si el QR ya volvió y attach o read fallan, no se libera el claim", async () => {
  const run = async (mode: "attach" | "read") => {
    let creates = 0;
    let fails = 0;
    const held = { token: null as string | null, claimedAtMs: null as number | null };
    const row: ChargeDraft = {
      id: "o",
      state: "CREATING",
      provider_charge_id: null,
      qr_payload: null,
      expires_at: "2026-11-15T18:03:00Z",
    };
    const store = {
      claim(token: string) {
        if (!canTakeChargeClaim(held, token, 60_000)) return Promise.resolve(null);
        held.token = token;
        held.claimedAtMs = 0;
        return Promise.resolve({ ...row });
      },
      read() {
        if (mode === "read") return Promise.reject(new Error("read_failed"));
        return Promise.resolve({ ...row });
      },
      attach() {
        if (mode === "attach") return Promise.reject(new Error("attach_failed"));
        return Promise.resolve(null);
      },
      fail() {
        fails += 1;
        held.token = null;
        row.state = "FAILED";
        return Promise.resolve();
      },
    };
    const outcome = await createChargeOnce(store, async () => {
      creates += 1;
      return { chargeId: "qr-ya-creado", qrPayload: "QR-YA", expiresAt: row.expires_at! };
    }, { token: "token-aaaa" });
    const second = await createChargeOnce(store, async () => {
      creates += 1;
      return { chargeId: "qr-nuevo", qrPayload: "QR-NUEVO", expiresAt: row.expires_at! };
    }, { token: "token-bbbb", attempts: 1, sleep: async () => {} });
    assert.equal(creates, 1, mode);
    assert.equal(fails, 0, mode);
    assert.equal(held.token, "token-aaaa", mode);
    assert.equal(row.state, "CREATING", mode);
    assert.equal("error" in outcome && outcome.error, "charge_uncertain", mode);
    assert.equal("charge" in outcome && outcome.charge?.chargeId, "qr-ya-creado", mode);
    assert.equal("error" in second && second.error, "in_progress", mode);
  };
  await run("attach");
  await run("read");
});

test("el día de corte usa America/Mexico_City", () => {
  assert.equal(mexicoCityDay(new Date("2026-11-15T05:30:00Z")), "2026-11-14");
  assert.equal(mexicoCityDay(new Date("2026-11-15T06:30:00Z")), "2026-11-15");
});

test("la conciliación no expira si el proveedor no contesta", () => {
  const expiresAt = "2026-11-15T18:00:00Z";
  const due = Date.parse(expiresAt) + 20_000;
  const base = {
    state: "AWAITING_PAYMENT",
    expiresAt,
    attempts: 0,
    unknownSince: null,
    nextReconcileAt: null,
    alerted: false,
  };
  assert.equal(reconcileAction({ ...base, nowMs: due - 1000, probe: "open" }).kind, "skip");
  assert.equal(reconcileAction({ ...base, nowMs: due, probe: "open" }).kind, "expire");
  assert.equal(reconcileAction({ ...base, nowMs: due, probe: "settled" }).kind, "pay");
  const unknown = reconcileAction({ ...base, nowMs: due, probe: "unreachable" });
  assert.equal(unknown.kind, "unknown");
  if (unknown.kind !== "unknown") return;
  assert.equal(unknown.alert, false);
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(6), 16 * 60_000);

  const start = Date.parse("2026-11-15T18:00:00Z");
  const exhausted = reconcileAction({
    state: "PENDING_UNKNOWN",
    expiresAt,
    nowMs: start + 30 * 60_000,
    probe: "unreachable",
    attempts: 4,
    unknownSince: new Date(start).toISOString(),
    nextReconcileAt: new Date(start).toISOString(),
    alerted: false,
  });
  assert.equal(exhausted.kind, "unknown");
  if (exhausted.kind === "unknown") {
    assert.equal(exhausted.alert, true);
    assert.equal(exhausted.nextReconcileAt, null);
  }
  assert.equal(reconcileAction({
    state: "PENDING_UNKNOWN",
    expiresAt,
    nowMs: start + 40 * 60_000,
    probe: "unreachable",
    attempts: 5,
    unknownSince: new Date(start).toISOString(),
    nextReconcileAt: null,
    alerted: true,
  }).kind, "skip");
  assert.equal(reconcileAction({
    state: "PENDING_UNKNOWN",
    expiresAt,
    nowMs: start + 40 * 60_000,
    probe: "settled",
    attempts: 5,
    unknownSince: new Date(start).toISOString(),
    nextReconcileAt: null,
    alerted: true,
  }).kind, "pay");
});

test("reglas SQL del Mock en Postgres embebido", { timeout: 120_000 }, async () => {
  const db = new PGlite();
  let pass = 0;
  let fail = 0;
  const failed: string[] = [];
  const check = (name: string, cond: boolean, detail = "") => {
    if (cond) {
      pass++;
      console.log(`  ✔ ${name}`);
    } else {
      fail++;
      failed.push(detail ? `${name}: ${detail}` : name);
      console.log(`  ✘ ${name}${detail ? ` (${detail})` : ""}`);
    }
  };

  try {
    await db.exec(`
      create schema if not exists auth;
      create table if not exists auth.users (id uuid primary key, email text);
      create or replace function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$;
      create schema if not exists realtime;
      create table if not exists realtime.messages (
        id bigserial primary key, payload jsonb, event text, topic text, private boolean, extension text
      );
      create or replace function realtime.topic() returns text language sql stable as $$
        select nullif(current_setting('realtime.topic', true), '')
      $$;
      create or replace function realtime.send(payload jsonb, event text, topic text, private boolean)
      returns void language plpgsql as $$
      begin
        insert into realtime.messages (payload, event, topic, private, extension)
        values (payload, event, topic, private, 'broadcast');
      end $$;
    `);
    for (const file of ["0001_core.sql", "0002_functions.sql", "0003_rls_realtime.sql", "0004_mock_and_limits.sql", "0006_payment_integrity.sql", "0007_charge_claim.sql", "0008_held_charge.sql"]) {
      let sql = readFileSync(join(root, "backend/supabase/migrations", file), "utf8");
      // PGlite ya trae gen_random_uuid() en el núcleo y no instala el archivo pgcrypto.control.
      if (file === "0001_core.sql") sql = sql.replace(/create extension if not exists pgcrypto;\s*/i, "");
      await db.exec(sql);
    }
    await db.exec(`
      insert into secret_words (word, spoken)
      select 'base-' || i, 'base ' || i from generate_series(1, 30) s(i);
      create or replace function test_fail_paid() returns trigger language plpgsql as $$
      begin
        if coalesce(current_setting('test.fail_paid', true), '') = 'on'
           and new.state = 'PAID' and old.state is distinct from 'PAID' then
          raise exception 'boom';
        end if;
        return new;
      end $$;
      create trigger orders_test_fail before update on orders
        for each row execute function test_fail_paid();
    `);

    const makeStall = async () => {
      const user = crypto.randomUUID();
      const merchant = crypto.randomUUID();
      const stall = crypto.randomUUID();
      await db.query("insert into auth.users (id, email) values ($1, $2)", [user, `${user}@demo.test`]);
      await db.query("insert into merchants (id, user_id, display_name) values ($1, $2, 'Demo')", [merchant, user]);
      await db.query(
        "insert into stalls (id, merchant_id, name, provider, public_announce) values ($1, $2, 'Puesto', 'mock', true)",
        [stall, merchant],
      );
      return { user, stall };
    };

    const createCodi = async (stall: string, user: string, idem: string, amount = 24000) => {
      const r = await db.query(
        "select * from create_order($1::uuid, $2::bigint, 'manual', 'codi', '[]'::jsonb, null, $3, $4::uuid, 'mock', 180)",
        [stall, amount, idem, user],
      );
      return r.rows[0] as { id: string; state: string; secret_word: string; secret_word_id: number; number: number };
    };

    const awaitPay = async (id: string, charge: string) => {
      await db.query(
        "update orders set state = 'AWAITING_PAYMENT', provider = 'mock', provider_charge_id = $2, qr_payload = 'QR' where id = $1::uuid",
        [id, charge],
      );
    };

    const pay = async (id: string, charge: string, eventId: string, amount: number, tx: string, tracking: string | null = tx) => {
      const r = await db.query(
        "select mark_order_paid('mock', $1, $2, $3::uuid, $4::bigint, $5, $6, '{\"simulated\":true}'::jsonb) as result",
        [eventId, charge, id, amount, tx, tracking],
      );
      const result = r.rows[0].result;
      return (typeof result === "string" ? JSON.parse(result) : result) as {
        outcome: string;
        duplicate: boolean;
        announced: boolean;
        state?: string;
        latePayment?: boolean;
      };
    };

    const customerPaid = async (id: string) => {
      const r = await db.query(
        "select count(*)::int as n from realtime.messages where event = 'order.paid' and topic like '%:customer' and payload->>'orderId' = $1",
        [id],
      );
      return Number(r.rows[0].n);
    };

    {
      const { user, stall } = await makeStall();
      const a = await createCodi(stall, user, "idem-a");
      const b = await createCodi(stall, user, "idem-a");
      check("la misma idempotencyKey devuelve la misma orden", a.id === b.id);
      const c = await createCodi(stall, user, "idem-b", 9000);
      check("dos órdenes llevan número y palabra distintos", a.number !== c.number && a.secret_word !== c.secret_word, `${a.secret_word} / ${c.secret_word}`);
      const rows = await db.query("select count(*)::int as n from orders where stall_id = $1", [stall]);
      check("el reintento no duplica la fila", Number(rows.rows[0].n) === 2);
    }

    {
      const { user, stall } = await makeStall();
      let rejected = false;
      try {
        await db.query(
          "select * from create_order($1::uuid, 24000, 'manual', 'codi', '[{\"qty\":1}]'::jsonb, null, 'bad-items', $2::uuid, 'mock', 180)",
          [stall, user],
        );
      } catch (error) {
        rejected = String(error).includes("invalid_items");
      }
      check("el servidor rechaza ítems sin nombre", rejected);
      const ok = await db.query(
        "select id from create_order($1::uuid, 24000, 'manual', 'codi', '[{\"product\":\"diezmillo\",\"qty\":1,\"unit\":\"kg\"}]'::jsonb, null, 'good-items', $2::uuid, 'mock', 180)",
        [stall, user],
      );
      check("acepta el ítem con product del ejemplo de despliegue", ok.rows.length === 1);
    }

    {
      const { user, stall } = await makeStall();
      const created = await createCodi(stall, user, "pay-1");
      await awaitPay(created.id, "ch-pay");
      const first = await pay(created.id, "ch-pay", "evt-pay", 24000, "tx-pay", "TRACK1");
      check("el pago confirmado queda PAID y se anuncia", first.outcome === "paid" && first.announced === true);
      const row = await db.query("select state, tracking_key, late_payment from orders where id = $1", [created.id]);
      check("guarda la clave de rastreo", row.rows[0].state === "PAID" && row.rows[0].tracking_key === "TRACK1" && row.rows[0].late_payment === false);
      check("el cliente recibe la palabra una vez", await customerPaid(created.id) === 1);
      const again = await pay(created.id, "ch-pay", "evt-pay", 24000, "tx-pay", "TRACK1");
      check("el duplicado no vuelve a anunciar", again.duplicate === true && again.announced === false && await customerPaid(created.id) === 1);

      const other = await createCodi(stall, user, "pay-2", 15000);
      await awaitPay(other.id, "ch-other");
      const reused = await pay(other.id, "ch-other", "evt-reuse", 15000, "tx-pay");
      check("el mismo transactionId no paga otra orden", reused.outcome === "duplicate_transaction");
      const otherState = await db.query("select state from orders where id = $1", [other.id]);
      check("la segunda orden sigue esperando", otherState.rows[0].state === "AWAITING_PAYMENT");
    }

    {
      const { user, stall } = await makeStall();
      const created = await createCodi(stall, user, "amt-1", 15000);
      await awaitPay(created.id, "ch-amt");
      const bad = await pay(created.id, "ch-amt", "evt-amt", 15100, "tx-amt");
      check("un monto distinto no paga", bad.outcome === "amount_mismatch");
      const again = await pay(created.id, "ch-amt", "evt-amt", 15100, "tx-amt");
      const audits = await db.query("select count(*)::int as n from audit_log where order_id = $1 and kind = 'amount_mismatch'", [created.id]);
      check("el reintento del monto distinto no duplica la auditoría", again.duplicate === true && Number(audits.rows[0].n) === 1);
      const state = await db.query("select state from orders where id = $1", [created.id]);
      check("sigue esperando pago", state.rows[0].state === "AWAITING_PAYMENT");

      const missing = await pay(crypto.randomUUID(), "ch-no", "evt-ref", 15000, "tx-ref");
      check("una referencia desconocida no paga", missing.outcome === "ref_mismatch");
      const wrongCharge = await pay(created.id, "ch-ajena", "evt-charge", 15000, "tx-charge");
      check("un QR distinto al de la orden no paga", wrongCharge.outcome === "ref_mismatch");
      const still = await db.query("select state from orders where id = $1", [created.id]);
      check("el QR equivocado no cambia el estado", still.rows[0].state === "AWAITING_PAYMENT");
    }

    {
      const { user, stall } = await makeStall();
      const created = await createCodi(stall, user, "boom-1");
      await awaitPay(created.id, "ch-boom");
      await db.exec("set test.fail_paid = 'on'");
      let blew = false;
      try {
        await pay(created.id, "ch-boom", "evt-boom", 24000, "tx-boom");
      } catch (error) {
        blew = String(error).includes("boom");
      }
      await db.exec("set test.fail_paid = 'off'");
      const events = await db.query("select count(*)::int as n from payment_events where event_id = 'evt-boom'");
      const state = await db.query("select state from orders where id = $1", [created.id]);
      check("si falla entre el evento y el estado, no queda nada a medias", blew && Number(events.rows[0].n) === 0 && state.rows[0].state === "AWAITING_PAYMENT");
      const recovered = await pay(created.id, "ch-boom", "evt-boom", 24000, "tx-boom");
      check("el mismo evento se puede reprocesar después del fallo", recovered.outcome === "paid");
    }

    {
      const { user, stall } = await makeStall();
      const created = await createCodi(stall, user, "late-1");
      await awaitPay(created.id, "ch-late");
      await db.query("update orders set state = 'CANCELLED' where id = $1", [created.id]);
      const late = await pay(created.id, "ch-late", "evt-late", 24000, "tx-late");
      const row = await db.query("select state, late_payment from orders where id = $1", [created.id]);
      const merchant = await db.query(
        "select count(*)::int as n from realtime.messages where event = 'order.late_payment' and topic like '%:merchant' and payload->>'orderId' = $1",
        [created.id],
      );
      check("el pago tardío queda PAID con la marca", late.outcome === "late_paid" && late.announced === false && row.rows[0].state === "PAID" && row.rows[0].late_payment === true);
      check("solo avisa al comerciante", Number(merchant.rows[0].n) === 1 && await customerPaid(created.id) === 0);
      await pay(created.id, "ch-late", "evt-late", 24000, "tx-late");
      const merchantAgain = await db.query(
        "select count(*)::int as n from realtime.messages where event = 'order.late_payment' and topic like '%:merchant' and payload->>'orderId' = $1",
        [created.id],
      );
      check("el pago tardío repetido no avisa otra vez", Number(merchantAgain.rows[0].n) === 1);
    }

    {
      const { user, stall } = await makeStall();
      const created = await createCodi(stall, user, "fix-1", 24000);
      await awaitPay(created.id, "ch-old");
      const replaced = await db.query(
        "select * from correct_order($1::uuid, 20000, 'manual', '[]'::jsonb, null, 'fix-2', $2::uuid, 'mock', 180)",
        [created.id, user],
      );
      const old = await db.query("select state, replaced_by, secret_word from orders where id = $1", [created.id]);
      const neu = replaced.rows[0] as { id: string; state: string; secret_word: string };
      check("corregir cancela la anterior y enlaza la nueva", old.rows[0].state === "CANCELLED" && old.rows[0].replaced_by === neu.id);
      check("la nueva orden lleva otra palabra", neu.secret_word !== old.rows[0].secret_word && neu.state === "CREATING");
      const again = await db.query(
        "select id from correct_order($1::uuid, 20000, 'manual', '[]'::jsonb, null, 'fix-2', $2::uuid, 'mock', 180)",
        [created.id, user],
      );
      check("repetir la corrección devuelve la misma orden", again.rows[0].id === neu.id);
      const late = await pay(created.id, "ch-old", "evt-old-qr", 24000, "tx-old-qr");
      const neuState = await db.query("select state from orders where id = $1", [neu.id]);
      check("el QR anterior aún puede registrarse como pago tardío", late.outcome === "late_paid" && neuState.rows[0].state === "CREATING");
      let blocked = false;
      try {
        await db.query(
          "select id from correct_order($1::uuid, 10000, 'manual', '[]'::jsonb, null, 'fix-paid', $2::uuid, 'mock', 180)",
          [created.id, user],
        );
      } catch (error) {
        blocked = String(error).includes("already_replaced") || String(error).includes("not_correctable");
      }
      const paid = await createCodi(stall, user, "cash-like", 5000);
      await db.query("update orders set state = 'PAID', paid_at = now() where id = $1", [paid.id]);
      try {
        await db.query(
          "select id from correct_order($1::uuid, 10000, 'manual', '[]'::jsonb, null, 'nope', $2::uuid, 'mock', 180)",
          [paid.id, user],
        );
      } catch (error) {
        blocked = blocked && String(error).includes("not_correctable");
      }
      check("no se corrige una orden ya pagada", blocked);
    }

    {
      await db.exec("update secret_words set active = false");
      const ids: number[] = [];
      for (let i = 1; i <= 201; i++) {
        const r = await db.query(
          "insert into secret_words (word, spoken, active) values ($1, $2, true) returning id",
          [`fb-${i}`, `palabra ${i}`],
        );
        ids.push(Number(r.rows[0].id));
      }
      const { stall } = await makeStall();
      for (let i = 0; i < 201; i++) {
        await db.query(
          `insert into orders (stall_id, number, amount_cents, amount_source, method, state, secret_word_id, secret_word, idempotency_key, provider, created_at)
           values ($1, $2, 1000, 'manual', 'codi', 'PAID', $3, $4, $5, 'mock', now() - make_interval(secs => $6::int))`,
          [stall, i + 1, ids[i], `palabra ${i + 1}`, `fb-${stall}-${i}`, 201 - i],
        );
      }
      const picked = await db.query("select id from pick_secret_word($1::uuid)", [stall]);
      check("si todas se usaron en 24 h, el fallback devuelve la más antigua fuera de las últimas 200", Number(picked.rows[0]?.id) === ids[0], `id ${picked.rows[0]?.id}`);

      const { stall: stall2 } = await makeStall();
      await db.query(
        `insert into orders (stall_id, number, amount_cents, amount_source, method, state, secret_word_id, secret_word, idempotency_key, provider, created_at)
         values ($1, 1, 1000, 'manual', 'codi', 'AWAITING_PAYMENT', $2, 'palabra 1', $3, 'mock', now() - interval '30 hours')`,
        [stall2, ids[0], `active-${stall2}`],
      );
      for (let i = 1; i < 201; i++) {
        await db.query(
          `insert into orders (stall_id, number, amount_cents, amount_source, method, state, secret_word_id, secret_word, idempotency_key, provider, created_at)
           values ($1, $2, 1000, 'manual', 'codi', 'PAID', $3, $4, $5, 'mock', now() - make_interval(secs => $6::int))`,
          [stall2, i + 1, ids[i], `palabra ${i + 1}`, `ac-${stall2}-${i}`, 200 - i],
        );
      }
      const blocked = await db.query("select id from pick_secret_word($1::uuid)", [stall2]);
      check("el fallback tampoco entrega una palabra de una orden activa", blocked.rows[0]?.id == null);

      await db.exec("update secret_words set active = false");
      await db.query("insert into secret_words (word, spoken, active) values ('solo-a', 'alfa', true), ('solo-b', 'beta', true)");
      const { user, stall: stall3 } = await makeStall();
      const first = await createCodi(stall3, user, "w24");
      const second = await db.query("select id from pick_secret_word($1::uuid)", [stall3]);
      const used = await db.query("select id from secret_words where spoken = $1", [first.secret_word]);
      check("no repite en 24 h la palabra que acaba de usar", Number(second.rows[0].id) !== Number(used.rows[0].id));
      await db.exec("update secret_words set active = true");
    }

    {
      const { stall } = await makeStall();
      await db.query(
        "insert into orders (stall_id, number, amount_cents, amount_source, method, idempotency_key, utterance_text, created_at) values ($1, 1, 1000, 'manual', 'cash', 'vieja', 'texto viejo', now() - interval '31 days')",
        [stall],
      );
      await db.query(
        "insert into orders (stall_id, number, amount_cents, amount_source, method, idempotency_key, utterance_text) values ($1, 2, 1000, 'manual', 'cash', 'nueva', 'texto nuevo')",
        [stall],
      );
      const purged = await db.query("select purge_old_utterances(30) as n");
      const left = await db.query("select utterance_text from orders where stall_id = $1 order by number", [stall]);
      check("borra transcripciones de más de 30 días y conserva las recientes", Number(purged.rows[0].n) >= 1 && left.rows[0].utterance_text === null && left.rows[1].utterance_text === "texto nuevo");
    }

    {
      const { user, stall } = await makeStall();
      const failed = await createCodi(stall, user, "idem-failed-expired");
      await db.query(
        "update orders set state = 'FAILED', expires_at = clock_timestamp() - interval '2 minutes', provider_charge_id = null where id = $1::uuid",
        [failed.id],
      );
      const claimed = await db.query(
        "select state, (expires_at > clock_timestamp()) as fresh from claim_order_charge($1::uuid, 'token-one-aaaa', 180)",
        [failed.id],
      );
      check(
        "el reintento de una FAILED vencida vuelve a CREATING y renueva expires_at",
        claimed.rows[0].state === "CREATING" && (claimed.rows[0].fresh === true || claimed.rows[0].fresh === "t"),
      );
      const second = await db.query(
        "select count(*)::int as n from claim_order_charge($1::uuid, 'token-two-bbbb', 180)",
        [failed.id],
      );
      check("un segundo claim simultáneo no obtiene el derecho a otro QR", Number(second.rows[0].n) === 0);
      await db.query(
        "update orders set charge_claimed_at = clock_timestamp() - interval '31 seconds' where id = $1::uuid",
        [failed.id],
      );
      const resumed = await db.query(
        "select count(*)::int as n from claim_order_charge($1::uuid, 'token-three-ccc', 180)",
        [failed.id],
      );
      check("un claim de más de 30 s no se lo queda otra solicitud", Number(resumed.rows[0].n) === 0);

      const raised = async (sql: string) => {
        try {
          await db.query(sql, [failed.id]);
          return "";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const missing = await raised("select * from recover_stuck_charge($1::uuid)");
      check("sin QR anotado la recuperación no suelta el claim", missing.includes("held_charge_missing"));
      const heldStill = await db.query("select state, charge_claim from orders where id = $1::uuid", [failed.id]);
      check(
        "el claim persiste si no hay QR que publicar",
        heldStill.rows[0].state === "CREATING" && heldStill.rows[0].charge_claim === "token-one-aaaa",
      );
      await db.query(
        "select * from record_held_charge($1::uuid, 'qr-retenido', 'QR-RETENIDO', clock_timestamp() + interval '3 minutes')",
        [failed.id],
      );
      const conflict = await raised(
        "select * from record_held_charge($1::uuid, 'qr-otro', 'QR-OTRO', clock_timestamp() + interval '3 minutes')",
      );
      check("no se sustituye el QR ya anotado", conflict.includes("held_charge_conflict"));
      const recovered = await db.query(
        "select state, provider_charge_id, qr_payload, charge_claim from recover_stuck_charge($1::uuid)",
        [failed.id],
      );
      check(
        "la recuperación manual publica ese QR y suelta el claim",
        recovered.rows[0].state === "AWAITING_PAYMENT"
          && recovered.rows[0].provider_charge_id === "qr-retenido"
          && recovered.rows[0].qr_payload === "QR-RETENIDO"
          && recovered.rows[0].charge_claim == null,
      );
      const repeated = await db.query("select provider_charge_id from recover_stuck_charge($1::uuid)", [failed.id]);
      check("repetir la recuperación no crea otro QR", repeated.rows[0].provider_charge_id === "qr-retenido");

      const waiting = await createCodi(stall, user, "idem-settled-mismatch");
      await awaitPay(waiting.id, "qr-mismatch");
      await db.query(
        "insert into mock_charges (charge_id, amount_cents, reference, status, transaction_id, tracking_key) values ('qr-mismatch', 100, $1, 'settled', 'tx-otro-monto', 'tx-otro-monto')",
        [waiting.id],
      );
      const mismatch = confirmedReconcilePayment(
        { id: waiting.id, amount_cents: 24000, provider_charge_id: "qr-mismatch" },
        { chargeId: "qr-mismatch", transactionId: "tx-otro-monto", amountCents: 100, trackingKey: "tx-otro-monto", reference: waiting.id },
      );
      check("el proveedor settled con otro monto no autoriza el pago", mismatch.pay === false && mismatch.reason === "amount_mismatch");
      const stillWaiting = await db.query("select state from orders where id = $1::uuid", [waiting.id]);
      check("esa orden sigue sin pagar", stillWaiting.rows[0].state === "AWAITING_PAYMENT");

      await db.exec("grant usage on schema public to anon, authenticated");
      await db.exec("grant select, insert on orders, secret_words to anon, authenticated");
      const anonOrders = async () => {
        await db.exec("set role anon");
        try {
          const orders = await db.query("select count(*)::int as n from orders");
          const words = await db.query("select count(*)::int as n from secret_words");
          let insertRejected = false;
          try {
            await db.query("insert into orders (stall_id, number, amount_cents, amount_source, method, idempotency_key) values (gen_random_uuid(), 1, 100, 'manual', 'cash', 'intruso')");
          } catch {
            insertRejected = true;
          }
          return { orders: Number(orders.rows[0].n), words: Number(words.rows[0].n), insertRejected };
        } finally {
          await db.exec("reset role");
        }
      };
      const anon = await anonOrders();
      check("el anónimo no lee órdenes ni palabras y no puede escribir", anon.orders === 0 && anon.words === 0 && anon.insertRejected);
      await db.exec("set role authenticated");
      let wordBank = -1;
      try {
        const words = await db.query("select count(*)::int as n from secret_words");
        wordBank = Number(words.rows[0].n);
      } finally {
        await db.exec("reset role");
      }
      check("el usuario autenticado tampoco lee el banco de palabras", wordBank === 0);
      const priv = await db.query("select has_function_privilege('anon', 'mark_order_paid(text,text,text,uuid,bigint,text,text,jsonb)', 'execute') as allowed");
      check("anon no puede ejecutar mark_order_paid", priv.rows[0].allowed === false);
    }

    console.log(`SQL embebido: ${pass} OK, ${fail} fallos`);
    assert.equal(fail, 0, failed.join("\n"));
  } finally {
    await db.close();
  }
});
