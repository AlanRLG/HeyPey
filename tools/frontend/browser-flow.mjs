import { chromium, expect } from '@playwright/test'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext()
const expiresAt = Math.floor(Date.now() / 1000) + 3600
const session = {
  access_token: 'test.token.signature',
  refresh_token: 'test-refresh',
  expires_at: expiresAt,
  expires_in: 3600,
  token_type: 'bearer',
  user: { id: 'test-user', aud: 'authenticated', email: 'merchant@example.invalid' },
}
await context.addInitScript((value) => localStorage.setItem('copiloto-web', JSON.stringify(value)), session)
const page = await context.newPage()
let order = null
let paid = false
let created = 0
let realCreated = 0
await page.route('**/rest/v1/stalls**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(route.request().url().includes('343eff54')
    ? { id: '343eff54-061f-434c-b0fd-2611c058092d', provider: 'pey' }
    : { id: 'abeea537-d585-4c7f-a14c-b768002f15c9', provider: 'mock' }),
}))
await page.route('**/edge-functions/public-orders?**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ orders: order ? [{
    orderId: order.orderId, number: order.number, amountCents: order.amountCents,
    state: paid ? 'PAID' : 'AWAITING_PAYMENT',
    qrPayload: paid ? null : order.qrPayload,
    expiresAt: order.expiresAt,
    secretWord: paid ? 'cajeta' : null,
  }] : [] }),
}))
await page.route('**/edge-functions/orders?**', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    orders: route.request().url().includes('343eff54')
      ? realCreated && order ? [order] : []
      : order ? [{ ...order, state: paid ? 'PAID' : 'AWAITING_PAYMENT' }] : [],
  }),
}))
await page.route('**/edge-functions/orders', async (route) => {
  if (route.request().method() !== 'POST') return route.continue()
  created++
  const body = route.request().postDataJSON()
  if (body.stallId === '343eff54-061f-434c-b0fd-2611c058092d') {
    realCreated++
    if (body.amountCents !== 1) throw new Error('Importe Pey incorrecto')
  }
  order = {
    orderId: '11111111-1111-4111-8111-111111111111', number: 24,
    amountCents: body.amountCents, method: 'codi', state: 'AWAITING_PAYMENT',
    secretWord: 'cajeta', qrPayload: 'MOCKCODI|SIMULADO|24',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    paidAt: null, latePayment: false, createdAt: new Date().toISOString(),
  }
  await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(order) })
})
await page.route('**/edge-functions/mock-pay', async (route) => {
  paid = true
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ webhookStatus: 200, webhook: { ok: true } }),
  })
})

await page.goto('http://127.0.0.1:5173/demo', { waitUntil: 'networkidle' })
await expect(page.getByText('Prepara el siguiente cobro')).toBeVisible()
await expect(page.locator('.customer-panel')).toHaveCount(1)
await page.getByLabel('Importe en pesos mexicanos').fill('45.00')
await page.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(page.getByText('Orden 24').first()).toBeVisible()
await expect(page.locator('.customer-panel').getByText('cajeta')).toHaveCount(0)
await expect(page.locator('.customer-panel').getByText('$45.00')).toBeVisible()
await page.getByRole('button', { name: 'Simular pago' }).click()
await expect(page.locator('.customer-panel').getByText('cajeta')).toBeVisible({ timeout: 7000 })
if (created !== 1) throw new Error('Se crearon ' + created + ' órdenes')
console.log('Flujo de navegador Mock: orden creada una vez, palabra oculta antes del pago y visible después.')
await page.goto('http://127.0.0.1:5173/comerciante?modo=pey', { waitUntil: 'networkidle' })
await expect(page.getByText('Prepara el siguiente cobro')).toBeVisible()
await expect(page.locator('.customer-panel')).toHaveCount(0)
await page.getByLabel('Importe en pesos mexicanos').fill('0.01')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await expect(page.getByText('Vas a generar un QR real por $0.01')).toBeVisible()
if (realCreated !== 0) throw new Error('Pey se llamó antes de confirmar')
await page.getByRole('button', { name: 'Volver' }).click()
if (realCreated !== 0) throw new Error('Pey se llamó al cancelar')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await page.getByRole('button', { name: 'Confirmar y generar QR' }).click()
await expect(page.getByText('Orden 24').first()).toBeVisible()
if (realCreated !== 1) throw new Error('Se crearon ' + realCreated + ' órdenes Pey')
console.log('Flujo de navegador Pey simulado: ninguna creación antes de confirmar; POST único de 1 centavo.')
await page.goto('http://127.0.0.1:5173/cliente?modo=pey', { waitUntil: 'networkidle' })
await expect(page.locator('.customer-panel')).toHaveCount(1)
await expect(page.locator('.merchant-panel')).toHaveCount(0)
console.log('Rutas separadas: comerciante privado y cliente público; ambas vistas solo en /demo.')
await browser.close()
