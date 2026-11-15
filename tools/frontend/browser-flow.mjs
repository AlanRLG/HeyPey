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

function attach(target, state) {
  return Promise.all([
    target.route('**/rest/v1/stalls**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(route.request().url().includes('343eff54')
        ? { id: '343eff54-061f-434c-b0fd-2611c058092d', provider: 'pey' }
        : { id: 'abeea537-d585-4c7f-a14c-b768002f15c9', provider: 'mock' }),
    })),
    target.route('**/edge-functions/public-orders?**', (route) => {
      if (state.failPublic) {
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ orders: state.order ? [{
          orderId: state.order.orderId, number: state.order.number, amountCents: state.order.amountCents,
          state: state.paid ? 'PAID' : 'AWAITING_PAYMENT',
          qrPayload: state.paid ? null : state.order.qrPayload,
          expiresAt: state.order.expiresAt,
          secretWord: state.paid && !state.withholdWord ? 'cajeta' : null,
        }] : [] }),
      })
    }),
    target.route('**/edge-functions/orders?**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        orders: route.request().url().includes('343eff54')
          ? state.realCreated && state.order ? [state.order] : []
          : state.order ? [{ ...state.order, state: state.paid ? 'PAID' : 'AWAITING_PAYMENT' }] : [],
      }),
    })),
    target.route('**/edge-functions/orders', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const body = route.request().postDataJSON()
      state.posts.push(body)
      if (state.failPost) {
        state.failPost = false
        state.created += 1
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
        return
      }
      state.created += 1
      if (body.stallId === '343eff54-061f-434c-b0fd-2611c058092d') {
        state.realCreated += 1
        if (!state.voicePhase && body.amountCents !== 1) throw new Error('Importe Pey incorrecto')
      }
      state.order = {
        orderId: '11111111-1111-4111-8111-111111111111', number: 24,
        amountCents: body.amountCents, method: body.method, state: 'AWAITING_PAYMENT',
        secretWord: 'cajeta', qrPayload: 'MOCKCODI|SIMULADO|24',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        paidAt: null, latePayment: false, createdAt: new Date().toISOString(),
      }
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(state.order) })
    }),
    target.route('**/edge-functions/mock-pay', async (route) => {
      state.paid = true
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ webhookStatus: 200, webhook: { ok: true } }),
      })
    }),
  ])
}

function freshState() {
  return { order: null, paid: false, created: 0, realCreated: 0, posts: [], failPost: false, voicePhase: false }
}

const state = freshState()
await attach(page, state)

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
if (state.created !== 1) throw new Error('Se crearon ' + state.created + ' órdenes')
if (state.posts[0].amountSource !== 'manual' || 'utterance' in state.posts[0]) {
  throw new Error('El alta manual no conservó amountSource manual')
}
console.log('Flujo de navegador Mock: orden creada una vez, palabra oculta antes del pago y visible después.')
await page.goto('http://127.0.0.1:5173/comerciante?modo=pey', { waitUntil: 'networkidle' })
await expect(page.getByText('Prepara el siguiente cobro')).toBeVisible()
await expect(page.locator('.customer-panel')).toHaveCount(0)
await page.getByLabel('Importe en pesos mexicanos').fill('0.01')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await expect(page.getByText('Vas a generar un QR real por $0.01')).toBeVisible()
if (state.realCreated !== 0) throw new Error('Pey se llamó antes de confirmar')
await page.getByRole('button', { name: 'Volver' }).click()
if (state.realCreated !== 0) throw new Error('Pey se llamó al cancelar')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await page.getByRole('button', { name: 'Confirmar y generar QR' }).click()
await expect(page.getByText('Orden 24').first()).toBeVisible()
if (state.realCreated !== 1) throw new Error('Se crearon ' + state.realCreated + ' órdenes Pey')
console.log('Flujo de navegador Pey simulado: ninguna creación antes de confirmar; POST único de 1 centavo.')
await page.goto('http://127.0.0.1:5173/cliente?modo=pey', { waitUntil: 'networkidle' })
await expect(page.locator('.customer-panel')).toHaveCount(1)
await expect(page.locator('.merchant-panel')).toHaveCount(0)
console.log('Rutas separadas: comerciante privado y cliente público; ambas vistas solo en /demo.')

const nativeSpeech = await page.evaluate(async () => {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Ctor) return { api: false, local: null }
  if (typeof Ctor.available !== 'function') return { api: true, local: 'sin available()' }
  try {
    return { api: true, local: await Ctor.available({ langs: ['es-MX'], processLocally: true }) }
  } catch {
    return { api: true, local: 'error' }
  }
})
console.log('Reconocimiento local del navegador de prueba:', JSON.stringify(nativeSpeech))

await context.addInitScript(() => {
  class FakeRecognition {
    static available(options) {
      const local = sessionStorage.getItem('speech-local') === '1'
      if (options && options.processLocally) return Promise.resolve(local ? 'available' : 'unavailable')
      return Promise.resolve('unavailable')
    }
    constructor() { window.__speech = this }
    start() {
      window.__speechStarts = (window.__speechStarts || 0) + 1
      const step = window.__speechNext || {}
      window.__speechNext = null
      if (step.error) {
        setTimeout(() => { this.onerror?.({ error: step.error }); this.onend?.() }, 20)
        return
      }
      if (step.interim) {
        setTimeout(() => this.onresult?.({
          results: { 0: { isFinal: false, 0: { transcript: step.interim } }, length: 1 },
        }), 10)
      }
      if (step.late) {
        this._late = () => this.onresult?.({
          results: { 0: { isFinal: true, 0: { transcript: step.final } }, length: 1 },
        })
        return
      }
      if (step.final) {
        setTimeout(() => this.onresult?.({
          results: { 0: { isFinal: true, 0: { transcript: step.final } }, length: 1 },
        }), 20)
      }
      if (!step.hang) setTimeout(() => this.onend?.(), 40)
    }
    abort() {
      if (this._late) setTimeout(this._late, 15)
      this.onend?.()
    }
    stop() { this.abort() }
  }
  window.SpeechRecognition = FakeRecognition
  window.webkitSpeechRecognition = FakeRecognition
})

state.voicePhase = true
await page.goto('http://127.0.0.1:5173/comerciante', { waitUntil: 'networkidle' })
const postsBeforeVoice = state.posts.length
await expect(page.getByRole('button', { name: 'Dictar importe' })).toBeVisible()
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByText('El navegador puede enviar tu voz a su servicio de reconocimiento. No guardamos audio ni transcripciones. También puedes escribir el importe.')).toBeVisible()
if (state.posts.length !== postsBeforeVoice) throw new Error('El consentimiento creó una orden')
await page.getByRole('button', { name: 'Escribir el importe' }).click()
await expect(page.getByText('El navegador puede enviar tu voz a su servicio de reconocimiento.')).toHaveCount(0)

await page.evaluate(() => {
  sessionStorage.setItem('speech-local', '1')
  window.__speechStarts = 0
})
await page.reload({ waitUntil: 'networkidle' })
await expect(page.getByRole('button', { name: 'Dictar importe' })).toBeVisible()
await page.evaluate((final) => { window.__speechNext = { final } }, 'Cóbrale, son doscientos cuarenta')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Aceptar y dictar' })).toHaveCount(0)
await expect(page.locator('#voice-review')).toContainText('240.00')
await expect(page.locator('#voice-review')).toContainText('Revisa el importe antes de continuar')
await expect(page.getByLabel('Importe en pesos mexicanos')).toHaveValue('240.00')
if (state.posts.length !== postsBeforeVoice) throw new Error('La transcripción creó una orden')

await page.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(page.getByText('Orden 24').first()).toBeVisible()
const spokenPost = state.posts.at(-1)
if (spokenPost.amountSource !== 'spoken' || spokenPost.amountCents !== 24000 || 'utterance' in spokenPost) {
  throw new Error('La orden dictada no salió como spoken sin transcripción')
}

await page.evaluate((final) => { window.__speechNext = { final } }, 'Cóbrale doscientos')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByLabel('Importe en pesos mexicanos')).toHaveValue('200.00')
await page.getByLabel('Importe en pesos mexicanos').fill('45.00')
await page.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(page.getByText('Orden creada').first()).toBeVisible()
const editedPost = state.posts.at(-1)
if (editedPost.amountSource !== 'manual' || editedPost.amountCents !== 4500) {
  throw new Error('Editar el importe no volvió el origen a manual')
}

await page.evaluate((final) => { window.__speechNext = { final } }, 'Cóbrale doscientos en efectivo')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByText('Elige Efectivo si quieres cambiarlo.')).toBeVisible()
await expect(page.getByRole('radio', { name: 'Pago CoDi' })).toHaveAttribute('data-state', 'on')
if (state.posts.length !== postsBeforeVoice + 2) throw new Error('Mencionar efectivo creó una orden')

await page.getByLabel('Importe en pesos mexicanos').fill('10.00')
await page.evaluate((interim) => { window.__speechNext = { interim, hang: true } }, 'Cóbrale doscientos')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Cancelar dictado' })).toBeVisible()
await expect(page.getByLabel('Importe en pesos mexicanos')).toHaveValue('10.00')
await page.getByRole('button', { name: 'Cancelar dictado' }).click()

await page.evaluate(() => { window.__speechStarts = 0; window.__speechNext = { hang: true } })
const postsBeforeDouble = state.posts.length
await page.getByRole('button', { name: 'Dictar importe' }).dblclick()
const starts = await page.evaluate(() => window.__speechStarts)
if (starts !== 1) throw new Error('El doble clic abrió ' + starts + ' escuchas')
if (state.posts.length !== postsBeforeDouble) throw new Error('El doble clic creó una orden')
const cancelDictation = page.getByRole('button', { name: 'Cancelar dictado' })
if (await cancelDictation.count()) await cancelDictation.click()
await expect(page.getByRole('button', { name: 'Dictar importe' })).toBeVisible()

await page.evaluate((final) => { window.__speechNext = { final, late: true } }, 'Cóbrale son cien')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await page.getByRole('button', { name: 'Cancelar dictado' }).click()
await expect(page.getByLabel('Importe en pesos mexicanos')).toHaveValue('10.00')

const beforeFailure = state.posts.length
state.failPost = true
await page.getByLabel('Importe en pesos mexicanos').fill('12.00')
await page.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(page.getByText('Resultado incierto.')).toBeVisible()
const uncertainKey = await page.evaluate(() => localStorage.getItem('copiloto:pending-order:mock'))
if (!uncertainKey) throw new Error('El fallo de red borró la clave de idempotencia')
await page.evaluate(() => { window.__speechNext = { error: 'not-allowed' } })
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByText('El navegador no permitió el micrófono.')).toBeVisible()
const keyAfterMic = await page.evaluate(() => localStorage.getItem('copiloto:pending-order:mock'))
if (keyAfterMic !== uncertainKey) throw new Error('El error de micrófono alteró la clave de idempotencia')
if (state.posts.length !== beforeFailure + 1) throw new Error('El error de micrófono creó otra orden')

const peyBefore = state.realCreated
await page.goto('http://127.0.0.1:5173/comerciante?modo=pey', { waitUntil: 'networkidle' })
await page.evaluate((final) => { window.__speechNext = { final } }, 'Cóbrale doscientos')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.locator('#voice-review')).toContainText('200.00')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await expect(page.getByText('Vas a generar un QR real por')).toBeVisible()
if (state.realCreated !== peyBefore) throw new Error('Pey se llamó al preparar el importe dictado')
await page.getByLabel('Importe en pesos mexicanos').fill('50.00')
await expect(page.getByRole('button', { name: 'Preparar QR real' })).toBeVisible()
await expect(page.getByRole('button', { name: 'Confirmar y generar QR' })).toHaveCount(0)
if (state.realCreated !== peyBefore) throw new Error('Editar el importe dictado llamó a Pey')

await page.goto('http://127.0.0.1:5173/cliente', { waitUntil: 'networkidle' })
await expect(page.getByRole('button', { name: 'Dictar importe' })).toHaveCount(0)
console.log('Dictado: llena el importe, no crea la orden y conserva la confirmación de Pey y la clave incierta.')

const silent = await browser.newContext()
await silent.addInitScript((value) => {
  localStorage.setItem('copiloto-web', JSON.stringify(value))
  for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    Object.defineProperty(window, name, { configurable: true, get: () => undefined })
  }
}, session)
const silentPage = await silent.newPage()
const silentState = freshState()
await attach(silentPage, silentState)
await silentPage.goto('http://127.0.0.1:5173/demo', { waitUntil: 'networkidle' })
await expect(silentPage.getByRole('button', { name: 'Dictar importe' })).toHaveCount(0)
await expect(silentPage.getByText('Este navegador no dicta importes. Escribe el monto.')).toBeVisible()
await silentPage.getByLabel('Importe en pesos mexicanos').fill('32.00')
await silentPage.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(silentPage.getByText('Orden 24').first()).toBeVisible()
await expect(silentPage.locator('.customer-panel').getByText('cajeta')).toHaveCount(0)
await silentPage.getByRole('button', { name: 'Simular pago' }).click()
await expect(silentPage.locator('.customer-panel').getByText('cajeta')).toBeVisible({ timeout: 7000 })
if (silentState.created !== 1 || silentState.posts[0].amountSource !== 'manual') {
  throw new Error('El navegador sin voz no completó el alta manual')
}
console.log('Navegador sin reconocimiento: el flujo manual de Mock sigue completo.')

await page.setViewportSize({ width: 320, height: 900 })
state.paid = false
state.withholdWord = false
state.failPublic = false
state.failPost = false
await page.evaluate(() => localStorage.removeItem('copiloto:pending-order:mock'))
await page.goto('http://127.0.0.1:5173/demo', { waitUntil: 'networkidle' })
await expect(page.getByRole('button', { name: 'Dictar importe' })).toBeVisible()
await page.getByLabel('Importe en pesos mexicanos').fill('18.00')
await page.getByRole('button', { name: 'Crear orden de prueba' }).click()
await expect(page.locator('.customer-panel .qr-frame')).toBeVisible()
const box320 = await page.locator('.customer-panel .qr-frame').boundingBox()
if (!box320 || box320.x < -1 || box320.x + box320.width > 321) throw new Error('QR desborda a 320 px ' + JSON.stringify(box320))
const timerInLiveRegion = await page.locator('.customer-state__timer').evaluate((el) => Boolean(el.closest('[role="status"]')))
if (timerInLiveRegion) throw new Error('El contador del QR está en la región viva')
await page.setViewportSize({ width: 390, height: 900 })
const box390 = await page.locator('.customer-panel .qr-frame').boundingBox()
if (!box390 || box390.x < -1 || box390.x + box390.width > 391) throw new Error('QR desborda a 390 px ' + JSON.stringify(box390))
await page.setViewportSize({ width: 1280, height: 900 })
await page.goto('http://127.0.0.1:5173/demo', { waitUntil: 'networkidle' })
await expect(page.locator('.merchant-panel')).toHaveCount(1)
await expect(page.locator('.customer-panel')).toHaveCount(1)
const scrolls = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
if (scrolls > 1) throw new Error('La demo a 1280 px desborda en horizontal')
const sound = page.getByRole('button', { name: 'Anuncio por voz' })
await expect(sound).toHaveAttribute('aria-pressed', 'false')
await sound.click()
await expect(sound).toHaveAttribute('aria-pressed', 'true')
await page.emulateMedia({ reducedMotion: 'reduce' })
const motion = await page.evaluate(() => {
  const probe = document.createElement('div')
  probe.className = 'customer-state__spinner'
  document.body.appendChild(probe)
  const duration = getComputedStyle(probe).animationDuration
  probe.remove()
  return duration
})
if (!(Number.parseFloat(motion) < 0.001)) throw new Error('reduced-motion no acortó la animación: ' + motion)

await page.evaluate(() => sessionStorage.setItem('speech-local', '0'))
await page.goto('http://127.0.0.1:5173/comerciante', { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Aceptar y dictar' })).toBeFocused()
await page.keyboard.press('Tab')
await expect(page.getByRole('button', { name: 'Escribir el importe' })).toBeFocused()
await page.keyboard.press('Enter')
await expect(page.getByText('El navegador puede enviar tu voz a su servicio de reconocimiento.')).toHaveCount(0)

state.failPublic = true
await page.goto('http://127.0.0.1:5173/cliente', { waitUntil: 'networkidle' })
await expect(page.getByText('No pudimos consultar las órdenes.')).toBeVisible()
await expect(page.locator('.merchant-panel')).toHaveCount(0)
state.failPublic = false
state.paid = true
state.withholdWord = true
await page.goto('http://127.0.0.1:5173/cliente', { waitUntil: 'networkidle' })
await expect(page.locator('.customer-panel--paid')).toBeVisible()
await expect(page.getByText('Esta orden no trae palabra pública.')).toBeVisible()
await expect(page.locator('.customer-panel').getByText('cajeta')).toHaveCount(0)
await expect(page.locator('.customer-panel').getByText('Esperando pago')).toHaveCount(0)
await page.goto('http://127.0.0.1:5173/cliente?modo=pey', { waitUntil: 'networkidle' })
await expect(page.locator('.merchant-panel')).toHaveCount(0)
await expect(page.getByRole('button', { name: 'Dictar importe' })).toHaveCount(0)
await expect(page.getByRole('button', { name: 'Crear orden de prueba' })).toHaveCount(0)
await expect(page.getByText('Pey · pago real')).toBeVisible()

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
await expect(page.getByText('El dictado web del importe ya existe en navegadores compatibles')).toBeVisible()
await expect(page.getByRole('heading', { name: 'Dos pantallas, un servidor.' })).toBeVisible()
await expect(page.getByText('Escribe o dicta el importe, lo revisa y después crea la orden.')).toBeVisible()
await page.getByRole('link', { name: 'Ver pantalla del cliente' }).click()
await expect(page).toHaveURL(/\/cliente/)
console.log('Integración: portada, QR contenido, anuncio, consentimiento, error público y PAID sin palabra.')

await page.evaluate(() => {
  sessionStorage.setItem('speech-local', '1')
  localStorage.removeItem('copiloto:pending-order:mock')
  localStorage.removeItem('copiloto:pending-order:pey')
})
state.failPost = false
const postsWhileDictating = state.posts.length
await page.goto('http://127.0.0.1:5173/comerciante', { waitUntil: 'networkidle' })
await page.getByLabel('Importe en pesos mexicanos').fill('45.00')
await page.evaluate(() => { window.__speechNext = { hang: true } })
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Crear orden de prueba' })).toBeDisabled()
await page.locator('.create-button').evaluate((button) => { button.disabled = false; button.click() })
if (state.posts.length !== postsWhileDictating) throw new Error('Un importe anterior creó una orden durante el dictado')
await expect(page.getByLabel('Importe en pesos mexicanos')).toHaveValue('45.00')
const keyWhileDictating = await page.evaluate(() => localStorage.getItem('copiloto:pending-order:mock'))
if (keyWhileDictating) throw new Error('El dictado escribió una clave de idempotencia')
await page.getByRole('button', { name: 'Cancelar dictado' }).click()

await page.evaluate(() => sessionStorage.setItem('speech-local', '0'))
await page.reload({ waitUntil: 'networkidle' })
await page.getByLabel('Importe en pesos mexicanos').fill('45.00')
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Crear orden de prueba' })).toBeDisabled()
await page.locator('.create-button').evaluate((button) => { button.disabled = false; button.click() })
if (state.posts.length !== postsWhileDictating) throw new Error('El aviso de consentimiento permitió crear la orden')
await page.getByRole('button', { name: 'Escribir el importe' }).click()

const peyWhileListening = state.realCreated
await page.evaluate(() => sessionStorage.setItem('speech-local', '1'))
await page.goto('http://127.0.0.1:5173/comerciante?modo=pey', { waitUntil: 'networkidle' })
await page.getByLabel('Importe en pesos mexicanos').fill('2.00')
await page.getByRole('button', { name: 'Preparar QR real' }).click()
await expect(page.getByRole('button', { name: 'Confirmar y generar QR' })).toBeVisible()
await page.evaluate(() => { window.__speechNext = { hang: true } })
await page.getByRole('button', { name: 'Dictar importe' }).click()
await expect(page.getByRole('button', { name: 'Confirmar y generar QR' })).toHaveCount(0)
await expect(page.getByRole('button', { name: 'Preparar QR real' })).toBeDisabled()
await page.locator('.create-button').evaluate((button) => { button.disabled = false; button.click() })
if (state.realCreated !== peyWhileListening) throw new Error('Pey confirmó durante la escucha')
await page.getByRole('button', { name: 'Cancelar dictado' }).click()
console.log('Dictado abierto: no crea órdenes, no confirma Pey y no toca la clave de idempotencia.')

await browser.close()
