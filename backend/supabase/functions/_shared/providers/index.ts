import { mockProvider } from "./mock.ts";
import { peyProvider } from "./pey.ts";
import type { PaymentProvider } from "./types.ts";

export function getProvider(name: string): PaymentProvider {
  if (name === "mock") return mockProvider;
  if (name === "pey") return peyProvider;
  throw new Error(`Proveedor desconocido: ${name}`);
}
