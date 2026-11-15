// Misma forma que order_items_valid en 0006_payment_integrity.sql.
// Se acepta "product" además de "name" porque así está el ejemplo de DEPLOY.md.

const NAME = /^.{1,80}$/u;

export function itemsError(items: unknown): string | null {
  if (!Array.isArray(items)) return "items";
  if (items.length > 50) return "items";
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "items";
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : typeof row.product === "string" ? row.product : "";
    if (!NAME.test(name)) return "items";
    if (row.qty != null && (typeof row.qty !== "number" || !Number.isFinite(row.qty))) return "items";
    if (row.unit != null && (typeof row.unit !== "string" || row.unit.length < 1 || row.unit.length > 20)) return "items";
    if (row.amountCents != null && (!Number.isInteger(row.amountCents) || (row.amountCents as number) < 0)) return "items";
  }
  return null;
}

export interface CatalogItem {
  name: string;
  aliases: string[];
  unit: string;
  priceCents: number;
  active: boolean;
}

export function parseCatalogBody(body: unknown): { stallId: string; items: CatalogItem[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "invalid_json" };
  const raw = body as Record<string, unknown>;
  if (typeof raw.stallId !== "string" || raw.stallId.length < 8) return { error: "stallId" };
  const list = Array.isArray(raw.items) ? raw.items : raw.name || raw.product ? [raw] : null;
  if (!list || list.length === 0 || list.length > 100) return { error: "items" };
  const items: CatalogItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return { error: "items" };
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!NAME.test(name)) return { error: "name" };
    if (!Number.isInteger(row.priceCents) || (row.priceCents as number) < 0) return { error: "priceCents" };
    const unit = row.unit == null ? "pza" : row.unit;
    if (typeof unit !== "string" || unit.length < 1 || unit.length > 20) return { error: "unit" };
    const aliases = row.aliases == null ? [] : row.aliases;
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string" || a.length > 80)) return { error: "aliases" };
    items.push({
      name,
      aliases: aliases as string[],
      unit,
      priceCents: row.priceCents as number,
      active: row.active == null ? true : row.active === true,
    });
  }
  return { stallId: raw.stallId, items };
}
