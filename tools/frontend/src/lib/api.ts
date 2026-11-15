import { createClient } from '@supabase/supabase-js'
import { orderRequestBody, type AmountSource } from './order-body.ts'

export { money, parseMoney } from './money.ts'

type PublicConfig = {
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  MOCK_STALL_ID: string
  PEY_STALL_ID: string
}

declare global {
  interface Window {
    COPILOTO_CONFIG?: PublicConfig
  }
}

export const config = window.COPILOTO_CONFIG
export const configured = Boolean(
  config?.SUPABASE_URL &&
  config?.SUPABASE_ANON_KEY &&
  config?.MOCK_STALL_ID &&
  config?.PEY_STALL_ID,
)

export const supabase = configured && config
  ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, storageKey: 'copiloto-web' },
    })
  : null

export type Provider = 'mock' | 'pey'
export type OrderState =
  | 'CREATING'
  | 'AWAITING_PAYMENT'
  | 'PENDING_UNKNOWN'
  | 'PAID'
  | 'PAID_CASH'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FAILED'

export type Order = {
  orderId: string
  number: number
  amountCents: number
  method: 'codi' | 'cash'
  state: OrderState
  secretWord: string | null
  qrPayload: string | null
  expiresAt: string | null
  paidAt: string | null
  latePayment: boolean
  createdAt?: string
}

export type PublicOrder = Omit<Order, 'method' | 'paidAt' | 'latePayment' | 'createdAt'> 

export function stallId(provider: Provider) {
  if (!config) return ''
  return provider === 'pey' ? config.PEY_STALL_ID : config.MOCK_STALL_ID
}

export const stateLabel: Record<OrderState, string> = {
  CREATING: 'Creando QR',
  AWAITING_PAYMENT: 'Esperando pago',
  PENDING_UNKNOWN: 'Verificando pago',
  PAID: 'Pago confirmado',
  PAID_CASH: 'Pagada en efectivo',
  EXPIRED: 'QR vencido',
  CANCELLED: 'Cancelada',
  FAILED: 'No se creó el QR',
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  if (!config || !supabase) throw new Error('Falta la configuración pública de Supabase.')
  const headers: Record<string, string> = { apikey: config.SUPABASE_ANON_KEY }
  if (options.auth) {
    const { data } = await supabase.auth.getSession()
    if (!data.session) throw new Error('Inicia sesión como comerciante.')
    headers.Authorization = 'Bearer ' + data.session.access_token
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  const base = import.meta.env.DEV ? '/edge-functions/' : config.SUPABASE_URL + '/functions/v1/'
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(
      typeof data.error === 'string' ? data.error : 'Error HTTP ' + response.status,
    ) as Error & { status?: number; details?: Record<string, unknown> }
    error.status = response.status
    error.details = data
    throw error
  }
  return data as T
}

export function publicOrders(provider: Provider) {
  return request<{ orders: PublicOrder[] }>(
    'public-orders?stallId=' + encodeURIComponent(stallId(provider)),
  )
}

export function merchantOrders(provider: Provider) {
  return request<{ orders: Order[] }>(
    'orders?stallId=' + encodeURIComponent(stallId(provider)) + '&view=merchant',
    { auth: true },
  )
}

export function createOrder(
  provider: Provider,
  amountCents: number,
  method: 'codi' | 'cash',
  key: string,
  amountSource: AmountSource = 'manual',
) {
  return request<Order>('orders', {
    method: 'POST',
    auth: true,
    body: orderRequestBody({
      stallId: stallId(provider),
      amountCents,
      method,
      idempotencyKey: key,
      amountSource,
    }),
  })
}

export function cancelOrder(orderId: string) {
  return request<Order>('orders/' + encodeURIComponent(orderId) + '/cancel', {
    method: 'POST',
    auth: true,
  })
}

export function simulatePayment(orderId: string) {
  return request<{ webhookStatus: number; webhook?: { ok?: boolean } }>('mock-pay', {
    method: 'POST',
    auth: true,
    body: { orderId },
  })
}
