// Standard Webhooks (https://github.com/standard-webhooks/standard-webhooks).
// El secreto `whsec_<base64>` se decodifica y firma `id.timestamp.cuerpo` con HMAC-SHA256.
const TOLERANCE_S = 5 * 60;

export function decodeWebhookSecret(secret: string): Uint8Array {
  const b64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signStandardWebhook(
  secret: string,
  webhookId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeWebhookSecret(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = `${webhookId}.${timestamp}.${body}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  return `v1,${encodeBase64(new Uint8Array(mac))}`;
}

export async function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - timestamp) > TOLERANCE_S) return false;
  const expected = await signStandardWebhook(secret, headers.id, timestamp, body);
  const expectedMac = expected.slice("v1,".length);
  return headers.signature.split(" ").some((part) => {
    const trimmed = part.trim();
    if (!trimmed.startsWith("v1,")) return false;
    return timingSafeEqual(expectedMac, trimmed.slice("v1,".length));
  });
}
