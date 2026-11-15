export type AmountSource = 'manual' | 'spoken'

export function orderRequestBody(input: {
  stallId: string
  amountCents: number
  method: 'codi' | 'cash'
  idempotencyKey: string
  amountSource?: AmountSource
}) {
  return {
    stallId: input.stallId,
    amountCents: input.amountCents,
    amountSource: input.amountSource ?? 'manual',
    method: input.method,
    items: [] as [],
    idempotencyKey: input.idempotencyKey,
  }
}
