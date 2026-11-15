// Centavos enteros ↔ pesos con dos decimales, sin arrastrar el error binario de un / 100 suelto.

export function centsToPesos(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("cents_not_integer");
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  return sign * Number(`${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
}

/** null si el peso no cae en un centavo exacto. */
export function pesosToCents(pesos: number): number | null {
  if (typeof pesos !== "number" || !Number.isFinite(pesos)) return null;
  const cents = Math.round(pesos * 100);
  if (Math.abs(pesos * 100 - cents) > 1e-6) return null;
  return cents;
}
