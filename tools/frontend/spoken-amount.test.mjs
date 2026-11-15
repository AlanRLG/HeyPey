import assert from 'node:assert/strict'
import test from 'node:test'
import { orderRequestBody } from './src/lib/order-body.ts'
import { parseSpokenAmount } from './src/lib/spoken-amount.ts'

function cents(phrase) {
  const parsed = parseSpokenAmount(phrase)
  assert.equal(parsed.ok, true, phrase + ' ' + JSON.stringify(parsed))
  return parsed.cents
}

test('convierte totales dichos después de Cóbrale', () => {
  assert.equal(cents('Cóbrale, son doscientos cuarenta'), 24000)
  assert.equal(cents('Cóbrale doscientos'), 20000)
  assert.equal(cents('Cóbrale, son 240 pesos'), 24000)
  assert.equal(cents('Cóbrale ciento veinte con cincuenta'), 12050)
  assert.equal(cents('Cóbrale mil quinientos'), 150000)
  assert.equal(cents('Cóbrale 240.50 pesos'), 24050)
  assert.equal(cents('Cóbrale, serían 240,50 pesos'), 24050)
  assert.equal(cents('Cóbrale dos mil quinientos'), 250000)
  assert.equal(cents('Cóbrale 0.01'), 1)
})

test('marca efectivo sin convertirlo en el método de pago', () => {
  const parsed = parseSpokenAmount('Cóbrale doscientos en efectivo')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.cents, 20000)
  assert.equal(parsed.mentionsCash, true)
})

test('rechaza frases ambiguas, de productos o sin activación', () => {
  assert.equal(parseSpokenAmount('dos cuarenta').reason, 'no_activation')
  assert.equal(parseSpokenAmount('Cóbrale dos cuarenta').reason, 'ambiguous')
  assert.equal(parseSpokenAmount('Cóbrale un kilo de pechuga').reason, 'products')
  assert.equal(parseSpokenAmount('Cóbrale un diez de cilantro').reason, 'products')
  assert.equal(parseSpokenAmount('hola, cóbrale doscientos').reason, 'no_activation')
  assert.equal(parseSpokenAmount('Cóbrale doscientos y trescientos').reason, 'ambiguous')
  assert.equal(parseSpokenAmount('Cóbrale').reason, 'incomplete')
  assert.equal(parseSpokenAmount('Cóbrale ciento').reason, 'incomplete')
  assert.equal(parseSpokenAmount('Cóbrale cero').reason, 'invalid')
  assert.equal(parseSpokenAmount('Cóbrale 12.345').reason, 'invalid')
  assert.equal(parseSpokenAmount('Cóbrale -5').reason, 'invalid')
})

test('el cuerpo de la orden no lleva transcripción', () => {
  const body = orderRequestBody({
    stallId: 'puesto',
    amountCents: 24000,
    method: 'codi',
    idempotencyKey: 'clave',
    amountSource: 'spoken',
  })
  assert.deepEqual(Object.keys(body).sort(), [
    'amountCents', 'amountSource', 'idempotencyKey', 'items', 'method', 'stallId',
  ])
  assert.equal(body.amountSource, 'spoken')
  assert.equal('utterance' in body, false)
  assert.equal(orderRequestBody({
    stallId: 'puesto', amountCents: 1, method: 'cash', idempotencyKey: 'otra',
  }).amountSource, 'manual')
})
