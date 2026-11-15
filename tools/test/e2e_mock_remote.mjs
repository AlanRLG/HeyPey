// Prueba de punta a punta contra Supabase alojado o local. Solo MockProvider.
// PowerShell (desde la raíz del repo):
//   $env:TEST_STALL_ID='<uuid del puesto mock>'
//   node tools/test/e2e_mock_remote.mjs
// El correo y la contraseña se piden en la terminal; la contraseña no se muestra.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(resolve(root, 'tools/simulator/config.js'), 'utf8');
const publicValue = (name) => config.match(new RegExp(`${name}:\\s*["']([^"']+)["']`))?.[1] ?? '';
const base = process.env.TEST_SUPABASE_URL || publicValue('SUPABASE_URL');
const anon = process.env.TEST_SUPABASE_ANON_KEY || publicValue('SUPABASE_ANON_KEY');
const stallId = process.env.TEST_STALL_ID || publicValue('STALL_ID');
if (!base || !anon || !stallId) {
  throw new Error('Falta TEST_STALL_ID (URL y anon key se leen de tools/simulator/config.js).');
}
if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(stallId)) throw new Error('TEST_STALL_ID no parece UUID');

async function promptLine(label) {
  if (!process.stdin.isTTY) throw new Error('Configura TEST_EMAIL en un terminal interactivo.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Configura TEST_PASSWORD en un terminal interactivo.');
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = (error) => {
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onKey = (char, key) => {
      if (key?.ctrl && key.name === 'c') return done(new Error('Cancelado'));
      if (key?.name === 'return' || key?.name === 'enter') return done();
      if (key?.name === 'backspace') { value = value.slice(0, -1); return; }
      if (char && !key?.ctrl && !key?.meta) value += char;
    };
    process.stdin.on('keypress', onKey);
  });
}

const email = process.env.TEST_EMAIL || await promptLine('Correo de la cuenta demo: ');
const password = process.env.TEST_PASSWORD || await promptSecret('Contraseña (no se muestra): ');

const fn = `${base.replace(/\/$/, '')}/functions/v1`;
const auth = `${base.replace(/\/$/, '')}/auth/v1`;
let jwt = '';
let passed = 0;

async function request(url, { method = 'GET', body, authenticated = false } = {}) {
  const headers = { apikey: anon };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (authenticated) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

function check(label, condition, detail = '') {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`);
  passed++;
  console.log(`OK ${passed}: ${label}`);
}

async function create(amountCents, method = 'codi') {
  return request(`${fn}/orders`, {
    method: 'POST', authenticated: true,
    body: { stallId, amountCents, amountSource: 'manual', method, items: [], idempotencyKey: crypto.randomUUID() },
  });
}

async function publicOrder(orderId) {
  const res = await request(`${fn}/public-orders?stallId=${stallId}`);
  check('public-orders responde', res.status === 200, JSON.stringify(res.data));
  return res.data.orders?.find((item) => item.orderId === orderId);
}

const login = await request(`${auth}/token?grant_type=password`, { method: 'POST', body: { email, password } });
if (login.status !== 200 || !login.data?.access_token) throw new Error(`Inicio de sesión falló (${login.status}); comprueba la cuenta de prueba.`);
jwt = login.data.access_token;
check('usuario de prueba inicia sesión', true);

const unauthorized = await request(`${fn}/orders?stallId=${stallId}`);
check('orders sin JWT rechaza acceso', unauthorized.status === 401, `HTTP ${unauthorized.status}`);

const created = await create(24000);
check('orden CoDi creada', created.status === 201 && created.data?.state === 'AWAITING_PAYMENT', JSON.stringify(created.data));
check('comerciante recibe palabra', typeof created.data.secretWord === 'string' && created.data.secretWord.length > 0);
const orderId = created.data.orderId;
const before = await publicOrder(orderId);
check('cliente no recibe palabra antes del pago', before?.secretWord == null, JSON.stringify(before));

const paid = await request(`${fn}/mock-pay`, { method: 'POST', authenticated: true, body: { orderId } });
check('mock-pay confirma el pago', paid.status === 200 && paid.data?.webhookStatus === 200 && paid.data?.webhook?.state === 'PAID', JSON.stringify(paid.data));
const after = await publicOrder(orderId);
check('cliente recibe palabra tras pago verificado', after?.state === 'PAID' && after.secretWord === created.data.secretWord);

const duplicate = await request(`${fn}/mock-pay`, { method: 'POST', authenticated: true, body: { orderId, eventId: paid.data.eventId } });
check('webhook duplicado no vuelve a pagar', duplicate.data?.webhook?.duplicate === true, JSON.stringify(duplicate.data));

const wrong = await create(15000);
check('segunda orden creada', wrong.status === 201 && wrong.data?.state === 'AWAITING_PAYMENT', JSON.stringify(wrong.data));
const mismatch = await request(`${fn}/mock-pay`, {
  method: 'POST', authenticated: true, body: { orderId: wrong.data.orderId, amountCents: 15100 },
});
check('monto distinto rechazado', mismatch.data?.webhook?.reason === 'amount_mismatch', JSON.stringify(mismatch.data));
const cancelled = await request(`${fn}/orders/${wrong.data.orderId}/cancel`, { method: 'POST', authenticated: true });
check('orden de monto distinto cancelada', cancelled.status === 200 && cancelled.data?.state === 'CANCELLED', JSON.stringify(cancelled.data));
const late = await request(`${fn}/mock-pay`, { method: 'POST', authenticated: true, body: { orderId: wrong.data.orderId } });
check('pago posterior a cancelación queda marcado como tardío', late.data?.webhook?.latePayment === true, JSON.stringify(late.data));
const latePublic = await publicOrder(wrong.data.orderId);
check('cliente no recibe palabra del pago tardío', latePublic == null || latePublic.secretWord == null);

const cash = await create(5000, 'cash');
check('efectivo registrado sin palabra', cash.status === 201 && cash.data?.state === 'PAID_CASH' && cash.data?.secretWord == null, JSON.stringify(cash.data));
// El servidor decide el día de negocio; el reloj del equipo puede diferir.
const summary = await request(`${fn}/summary?stallId=${stallId}`, { authenticated: true });
check('corte incluye CoDi y efectivo', summary.status === 200 && summary.data?.codi?.count >= 1 && summary.data?.cash?.count >= 1, JSON.stringify(summary.data));
check('corte informa pendientes', Number.isInteger(summary.data?.pending), JSON.stringify(summary.data));

console.log(`Resultado: ${passed} comprobaciones OK. Solo MockProvider; no se llamó a pey.`);
