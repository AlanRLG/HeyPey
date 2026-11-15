// Quién puede ver la pantalla pública y quién puede simular un pago.
export function publicStallVisible(provider: string, publicAnnounce: boolean): boolean {
  return publicAnnounce === true && (provider === "mock" || provider === "pey");
}

export function mockPayAllowed(orderProvider: string, stallProvider: string): boolean {
  return orderProvider === "mock" && stallProvider === "mock";
}

/** Quita de un texto de error lo que no debe salir en una respuesta o un log. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9+/=]+/g, "[redacted]")
    .replace(/\b\d{18}\b/g, "[redacted]");
}
