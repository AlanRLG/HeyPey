// Utilidades compartidas del simulador. Toda decisión de pago vive en el servidor:
// el navegador solo crea órdenes, pide un pago SIMULADO a /mock-pay y escucha eventos.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

export const cfg = window.COPILOTO_CONFIG ?? {};
export const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && cfg.STALL_ID && cfg.DEMO_EMAIL);

export const supabase = configured
  ? createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: true, storageKey: "copiloto-demo" } })
  : null;

export const money = (cents) =>
  (cents / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });

export const STATE_LABEL = {
  CREATING: "Creando", AWAITING_PAYMENT: "Esperando pago", PENDING_UNKNOWN: "Verificando",
  PAID: "Pagada", PAID_CASH: "Efectivo", EXPIRED: "Expirada", CANCELLED: "Cancelada", FAILED: "Falló",
};

export function showConfigNotice(container) {
  container.innerHTML = `<div class="notice error"><strong>Simulador sin configurar.</strong>
    Falta rellenar <code>tools/simulator/config.js</code> (URL de Supabase, anon key, puesto y cuenta de demo).
    Ver DEPLOY.md §6.</div>`;
}

export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return data.session;
  const { data: d, error } = await supabase.auth.signInWithPassword({ email: cfg.DEMO_EMAIL, password: cfg.DEMO_PASSWORD });
  if (error) throw new Error(`No se pudo iniciar sesión de demo: ${error.message}`);
  return d.session;
}

async function token() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? (await ensureSession()).access_token;
}

export async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      apikey: cfg.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

export const listOrders = (view) => api(`orders?stallId=${encodeURIComponent(cfg.STALL_ID)}&view=${view}`);

export const mockPay = (orderId, extra = {}) =>
  api("mock-pay", { method: "POST", body: { orderId, ...extra }, headers: { "x-mock-pay-token": cfg.MOCK_PAY_TOKEN ?? "" } });

/** Suscripción a un canal privado (B5) + polling cada 5 s como respaldo si cae el WebSocket. */
export async function subscribe(role, onEvent, onPoll, onStatus) {
  const session = await ensureSession();
  supabase.realtime.setAuth(session.access_token);
  supabase.auth.onAuthStateChange((_e, s) => s && supabase.realtime.setAuth(s.access_token));

  const channel = supabase
    .channel(`stall:${cfg.STALL_ID}:${role}`, { config: { private: true } })
    .on("broadcast", { event: "*" }, ({ event, payload }) => onEvent(event, payload))
    .subscribe((status) => onStatus?.(status === "SUBSCRIBED", status));

  const poll = async () => { try { await onPoll(); } catch (e) { console.warn("polling", e); } };
  await poll();
  setInterval(poll, 5000);
  return channel;
}

// ---- Audio: tono + voz del sistema (anuncio) ----
let audioCtx;
export function unlockAudio() {
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
}
export function earcon(kind = "paid") {
  try {
    unlockAudio();
    const notes = kind === "paid" ? [660, 880] : [440, 330];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = "sine";
      const t = audioCtx.currentTime + i * 0.16;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.16);
    });
  } catch { /* sin audio */ }
}
export function say(text) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-MX"; u.rate = 0.95;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
