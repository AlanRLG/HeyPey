import { centsToField, parseMoney } from './money.ts'

export type SpokenAmount =
  | { ok: true; cents: number; mentionsCash: boolean }
  | { ok: false; reason: 'no_activation' | 'ambiguous' | 'products' | 'incomplete' | 'invalid'; message: string }

const MESSAGES = {
  no_activation: 'Empieza con «Cóbrale» y di el total. También puedes escribirlo.',
  ambiguous: 'Hay más de un importe posible. Repite solo el total o escríbelo.',
  products: 'Escuché productos, no un total único. Escribe el importe.',
  incomplete: 'No escuché el importe completo. Repítelo o escríbelo.',
  invalid: 'No reconocí un importe válido. Escríbelo, por ejemplo 45.00.',
} as const

const UNITS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4,
  cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
}
const TEENS: Record<string, number> = {
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
}
const TWENTIES: Record<string, number> = {
  veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27,
  veintiocho: 28, veintinueve: 29,
}
const TENS: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90,
}
const HUNDREDS: Record<string, number> = {
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
}
const CURRENCY = new Set(['peso', 'pesos', 'mxn', 'mexicanos'])
const PRODUCTS = new Set([
  'kilo', 'kilos', 'kg', 'gramo', 'gramos', 'pieza', 'piezas',
  'litro', 'litros', 'manojo', 'manojos', 'docena', 'docenas', 'pechuga', 'cilantro',
])

type Read = { value: number; next: number } | { error: 'ambiguous' | 'incomplete' | 'invalid' }

export function normalizeUtterance(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\d)[.,](\d)/g, '$1.$2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function fail(reason: Exclude<SpokenAmount, { ok: true }>['reason']): SpokenAmount {
  return { ok: false, reason, message: MESSAGES[reason] }
}

function isSmall(token: string | undefined): boolean {
  if (!token) return false
  return TEENS[token] != null || TWENTIES[token] != null || TENS[token] != null || UNITS[token] != null || /^\d{1,2}$/.test(token)
}

function isNumberish(token: string): boolean {
  return isSmall(token) || HUNDREDS[token] != null || token === 'mil' || token === 'cientos' || /^\d{1,6}(?:[.,]\d{1,2})?$/.test(token)
}

function readUnder100(tokens: string[], index: number): Read {
  const token = tokens[index]
  if (TEENS[token] != null || TWENTIES[token] != null) {
    return { value: TEENS[token] ?? TWENTIES[token], next: index + 1 }
  }
  if (TENS[token] != null) {
    let value = TENS[token]
    let next = index + 1
    if (tokens[next] === 'y') {
      const unit = UNITS[tokens[next + 1]]
      if (unit == null || unit < 1) return { error: 'incomplete' }
      value += unit
      next += 2
    }
    return { value, next }
  }
  if (UNITS[token] != null) return { value: UNITS[token], next: index + 1 }
  if (/^\d{1,2}$/.test(token)) return { value: Number(token), next: index + 1 }
  return { error: 'invalid' }
}

function finishHundred(tokens: string[], index: number, base: number): Read {
  if (!isSmall(tokens[index])) return { value: base, next: index }
  const small = readUnder100(tokens, index)
  if ('error' in small) return small
  if (small.value > 99) return { error: 'invalid' }
  return { value: base + small.value, next: small.next }
}

function readUnder1000(tokens: string[], index: number): Read | null {
  if (index >= tokens.length) return null
  const token = tokens[index]
  const compound = UNITS[token]
  if (compound != null && tokens[index + 1] === 'cientos') {
    if (compound < 2 || compound > 9) return { error: 'invalid' }
    return finishHundred(tokens, index + 2, compound * 100)
  }
  if (HUNDREDS[token] != null) {
    if (token === 'ciento' && !isSmall(tokens[index + 1])) return { error: 'incomplete' }
    return finishHundred(tokens, index + 1, HUNDREDS[token])
  }
  if (!isSmall(token)) return null
  return readUnder100(tokens, index)
}

function afterMil(tokens: string[], index: number, base: number): Read {
  const tail = readUnder1000(tokens, index)
  if (tail && 'error' in tail) return tail
  if (!tail) return { value: base, next: index }
  return { value: base + tail.value, next: tail.next }
}

function readPesos(tokens: string[], index: number): Read {
  const head = readUnder1000(tokens, index)
  if (head && 'error' in head) return head
  if (head && tokens[head.next] === 'mil') {
    if (head.value < 1 || head.value > 999) return { error: 'invalid' }
    return afterMil(tokens, head.next + 1, head.value * 1000)
  }
  if (tokens[index] === 'mil') return afterMil(tokens, index + 1, 1000)
  if (head) return { value: head.value, next: head.next }
  return { error: 'invalid' }
}

function consumeCurrency(tokens: string[], index: number): number {
  let next = index
  while (CURRENCY.has(tokens[next] ?? '')) next += 1
  return next
}

function hasProductTalk(tokens: string[]): boolean {
  if (tokens.some((token) => PRODUCTS.has(token))) return true
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] === 'de' && !CURRENCY.has(tokens[i + 1]) && !isNumberish(tokens[i + 1])) return true
  }
  return false
}

function pullCash(tokens: string[]): { tokens: string[]; mentionsCash: boolean } {
  const mentionsCash = tokens.includes('efectivo')
  const next: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'en' && tokens[i + 1] === 'efectivo') {
      i += 1
      continue
    }
    if (tokens[i] === 'efectivo') continue
    next.push(tokens[i])
  }
  return { tokens: next, mentionsCash }
}

function leftover(tokens: string[], index: number): SpokenAmount | null {
  if (index >= tokens.length) return null
  return fail(tokens.slice(index).some(isNumberish) ? 'ambiguous' : 'invalid')
}

export function parseSpokenAmount(transcript: string): SpokenAmount {
  if (/[-−]/.test(transcript)) return fail('invalid')
  const tokens = normalizeUtterance(transcript).split(' ').filter(Boolean)
  if (tokens[0] !== 'cobrale') return fail('no_activation')
  const pulled = pullCash(tokens.slice(1))
  let rest = pulled.tokens
  if (hasProductTalk(rest)) return fail('products')
  if (['son', 'seria', 'serian'].includes(rest[0] ?? '')) rest = rest.slice(1)
  if (!rest.length) return fail('incomplete')

  if (/^\d{1,6}(?:[.,]\d{1,2})?$/.test(rest[0])) {
    const cents = parseMoney(rest[0])
    if (cents == null) return fail('invalid')
    const next = consumeCurrency(rest, 1)
    if (rest[next] === 'con') return fail('ambiguous')
    const extra = leftover(rest, next)
    if (extra) return extra
    return { ok: true, cents, mentionsCash: pulled.mentionsCash }
  }

  const pesos = readPesos(rest, 0)
  if ('error' in pesos) return fail(pesos.error)
  let next = consumeCurrency(rest, pesos.next)
  let cents = pesos.value * 100
  if (rest[next] === 'con') {
    if (!isSmall(rest[next + 1])) return fail('incomplete')
    const fraction = readUnder100(rest, next + 1)
    if ('error' in fraction) return fail(fraction.error)
    if (fraction.value > 99) return fail('invalid')
    cents += fraction.value
    next = consumeCurrency(rest, fraction.next)
  }
  const extra = leftover(rest, next)
  if (extra) return extra
  if (!Number.isSafeInteger(cents) || cents <= 0) return fail('invalid')
  if (parseMoney(centsToField(cents)) !== cents) return fail('invalid')
  return { ok: true, cents, mentionsCash: pulled.mentionsCash }
}
