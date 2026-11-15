export interface SummaryOrder {
  id: string;
  number: number;
  method: string;
  state: string;
  amount_cents: number;
  late_payment: boolean;
  reconcile_alerted_at: string | null;
}

export interface DaySummary {
  day: string;
  stallId: string;
  codi: { count: number; amountCents: number };
  cash: { count: number; amountCents: number };
  latePayments: number;
  /** Órdenes del día que aún no se cobraron: CREATING, AWAITING_PAYMENT y PENDING_UNKNOWN. */
  pending: number;
  alerts: { orderId: string; number: number; alertedAt: string }[];
}

export function mexicoCityDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(now);
}

export function buildSummary(stallId: string, day: string, rows: SummaryOrder[]): DaySummary {
  const summary: DaySummary = {
    day,
    stallId,
    codi: { count: 0, amountCents: 0 },
    cash: { count: 0, amountCents: 0 },
    latePayments: 0,
    pending: 0,
    alerts: [],
  };
  for (const row of rows) {
    if (row.state === "CREATING" || row.state === "AWAITING_PAYMENT" || row.state === "PENDING_UNKNOWN") {
      summary.pending += 1;
    }
    if (row.method === "codi" && row.state === "PAID") {
      summary.codi.count += 1;
      summary.codi.amountCents += row.amount_cents;
      if (row.late_payment) summary.latePayments += 1;
    } else if (row.method === "cash" && row.state === "PAID_CASH") {
      summary.cash.count += 1;
      summary.cash.amountCents += row.amount_cents;
    }
    if (row.reconcile_alerted_at) {
      summary.alerts.push({ orderId: row.id, number: row.number, alertedAt: row.reconcile_alerted_at });
    }
  }
  return summary;
}
