import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowRight, Check, CircleAlert, Clock3, LockKeyhole, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  cancelOrder, configured, createOrder, merchantOrders, money, parseMoney,
  simulatePayment, stallId, stateLabel, supabase,
  type Order, type Provider,
} from '@/lib/api'

type Props = {
  provider: Provider
  onProviderChange?: (provider: Provider) => void
}

const intentStorage = (provider: Provider) => 'copiloto:pending-order:' + provider

function privateState(order: Order) {
  return order.latePayment ? 'Pago tardío · no anunciado' : stateLabel[order.state]
}

export function MerchantPanel({ provider, onProviderChange }: Props) {
  const [session, setSession] = useState<Session | null>(null)
  const [authChecked, setAuthChecked] = useState(!supabase)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [busy, setBusy] = useState(false)
  const [orders, setOrders] = useState<Order[]>([])
  const [listError, setListError] = useState('')
  const [stallVerified, setStallVerified] = useState(false)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'codi' | 'cash'>('codi')
  const [confirmReal, setConfirmReal] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null)
  const [now, setNow] = useState(0)
  const sessionUserRef = useRef<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let mounted = true
    void supabase.auth.getSession().then(({ data }) => {
      if (mounted) { setSession(data.session); setAuthChecked(true) }
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (mounted) {
        const nextUserId = next?.user.id ?? null
        if (sessionUserRef.current !== nextUserId) {
          sessionUserRef.current = nextUserId
          setOrders([])
          setStallVerified(false)
          setLastCreatedId(null)
          setActionMessage('')
        }
        setSession(next)
        setAuthChecked(true)
      }
    })
    return () => { mounted = false; data.subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!session || !supabase) return
    let active = true
    let loading = false
    const verify = async () => {
      const { data, error } = await supabase!.from('stalls')
        .select('id, provider')
        .eq('id', stallId(provider))
        .maybeSingle()
      if (!active) return
      if (error || !data || data.provider !== provider) {
        setListError('Esta cuenta no tiene acceso al puesto ' + (provider === 'pey' ? 'Pey' : 'Mock') + '.')
        return
      }
      setStallVerified(true)
    }
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const result = await merchantOrders(provider)
        if (active) { setOrders(result.orders); setListError('') }
      } catch (error) {
        if (active) setListError(error instanceof Error ? error.message : 'No se pudieron cargar las órdenes.')
      } finally {
        loading = false
      }
    }
    void verify()
    void refresh()
    const interval = window.setInterval(refresh, 3000)
    return () => { active = false; window.clearInterval(interval) }
  }, [session, provider])

  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) return
    setBusy(true)
    setAuthError('')
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setPassword('')
    if (error) setAuthError('No pudimos iniciar sesión. Revisa el correo y la contraseña.')
    setBusy(false)
  }

  async function refreshOrders() {
    try {
      const result = await merchantOrders(provider)
      setOrders(result.orders)
      setListError('')
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'No se pudieron cargar las órdenes.')
    }
  }

  async function submitOrder() {
    if (!stallVerified || busy) return
    const cents = parseMoney(amount)
    if (cents === null) {
      setActionMessage('Escribe un importe válido, por ejemplo 45.00.')
      return
    }
    if (provider === 'pey' && method === 'codi' && !confirmReal) {
      setConfirmReal(true)
      setActionMessage('')
      return
    }
    if (localStorage.getItem(intentStorage(provider))) {
      setActionMessage('Hay un intento anterior sin resolver. Consulta las órdenes antes de generar otro QR.')
      return
    }
    const intent = {
      key: crypto.randomUUID(),
      amountCents: cents,
      method,
      startedAt: new Date().toISOString(),
    }
    localStorage.setItem(intentStorage(provider), JSON.stringify(intent))
    setBusy(true)
    setActionMessage('Creando orden en el servidor…')
    try {
      const created = await createOrder(provider, cents, method, intent.key)
      localStorage.removeItem(intentStorage(provider))
      setOrders((old) => [created, ...old.filter((order) => order.orderId !== created.orderId)])
      setLastCreatedId(created.orderId)
      setAmount('')
      setConfirmReal(false)
      setActionMessage(
        created.state === 'PAID_CASH'
          ? 'Efectivo registrado. La palabra permanece en la vista privada.'
          : 'Orden creada. El pago solo se confirmará cuando lo verifique el servidor.',
      )
      void refreshOrders()
    } catch (error) {
      const knownRejection = error instanceof Error &&
        'status' in error &&
        typeof error.status === 'number' &&
        [400, 401, 403, 422].includes(error.status)
      if (knownRejection) localStorage.removeItem(intentStorage(provider))
      setActionMessage(
        knownRejection
          ? 'No se creó la orden: ' + (error as Error).message
          : 'Resultado incierto. No generes otro QR. Consulta las órdenes y conserva este navegador.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function orderAction(order: Order, action: 'pay' | 'cancel') {
    if (busy) return
    setBusy(true)
    setActionMessage(action === 'pay' ? 'Enviando pago simulado…' : 'Cancelando orden…')
    try {
      if (action === 'pay') {
        const result = await simulatePayment(order.orderId)
        setActionMessage(
          result.webhook?.ok
            ? 'Evento simulado enviado. Espera la confirmación del servidor.'
            : 'El servidor todavía no confirmó el pago. Consulta de nuevo.',
        )
      } else {
        await cancelOrder(order.orderId)
        setActionMessage('Orden cancelada.')
      }
      await refreshOrders()
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'La acción no se completó.')
    } finally {
      setBusy(false)
    }
  }

  if (!configured) {
    return <Alert variant="destructive"><CircleAlert /><AlertTitle>Falta configuración</AlertTitle><AlertDescription>Revisa el archivo público de configuración de Supabase.</AlertDescription></Alert>
  }

  if (!authChecked) {
    return <Card className="merchant-panel"><CardContent className="py-12 text-center">Comprobando sesión…</CardContent></Card>
  }

  if (!session) {
    return (
      <Card className="merchant-panel merchant-panel--login">
        <CardHeader>
          <p className="surface-label">Vista privada</p>
          <CardTitle className="text-2xl">Entra como comerciante</CardTitle>
          <CardDescription>La pantalla del cliente funciona sin iniciar sesión. Aquí puedes crear órdenes y ver la palabra asignada.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={signIn} className="merchant-login">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="merchant-email">Correo electrónico</FieldLabel>
                <Input id="merchant-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="merchant-password">Contraseña</FieldLabel>
                <Input id="merchant-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </Field>
            </FieldGroup>
            {authError && <p className="inline-error" role="alert">{authError}</p>}
            <Button type="submit" size="lg" disabled={busy}>{busy ? 'Entrando…' : 'Entrar al puesto'} <ArrowRight aria-hidden="true" /></Button>
          </form>
        </CardContent>
      </Card>
    )
  }

  const lastCreated = orders.find((order) => order.orderId === lastCreatedId)

  return (
    <div className="merchant-workspace">
      <Card className="merchant-panel">
        <CardHeader className="merchant-panel__heading">
          <div>
            <p className="surface-label">Vista privada del comerciante</p>
            <CardTitle className="text-2xl">Prepara el siguiente cobro</CardTitle>
            <CardDescription>El importe queda visible para el cliente; la palabra se queda contigo.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => supabase?.auth.signOut({ scope: 'local' })}>Salir</Button>
        </CardHeader>
        <CardContent className="merchant-panel__body">
          {onProviderChange && (
            <div className="provider-picker">
              <span>Proveedor del puesto</span>
              <ToggleGroup type="single" value={provider} onValueChange={(value) => {
                if (value === 'mock' || value === 'pey') onProviderChange(value)
              }} variant="outline" aria-label="Proveedor del puesto">
                <ToggleGroupItem value="mock" aria-label="Puesto de prueba">Mock</ToggleGroupItem>
                <ToggleGroupItem value="pey" aria-label="Puesto Pey real">Pey real</ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          <div className={'provider-note ' + (provider === 'pey' ? 'provider-note--real' : '')}>
            {provider === 'mock'
              ? 'Modo demo: el QR y el pago son simulados. No se mueve dinero.'
              : 'Pey real: generar el QR puede iniciar un cobro bancario. Verifica el importe antes de continuar.'}
          </div>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="order-amount">Importe en pesos mexicanos</FieldLabel>
              <div className="amount-input">
                <span aria-hidden="true">$</span>
                <Input
                  id="order-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="45.00"
                  value={amount}
                  onChange={(event) => { setAmount(event.target.value); setConfirmReal(false) }}
                  aria-describedby="amount-help"
                />
                <span aria-hidden="true">MXN</span>
              </div>
              <p id="amount-help" className="field-hint">Usa hasta dos decimales. El servidor valida el límite permitido.</p>
            </Field>
            <Field>
              <FieldLabel>Método de pago</FieldLabel>
              <ToggleGroup type="single" value={method} onValueChange={(value) => {
                if (value === 'codi' || value === 'cash') setMethod(value)
              }} variant="outline" aria-label="Método de pago">
                <ToggleGroupItem value="codi" aria-label="Pago CoDi">CoDi</ToggleGroupItem>
                <ToggleGroupItem value="cash" aria-label="Pago en efectivo">Efectivo</ToggleGroupItem>
              </ToggleGroup>
            </Field>
          </FieldGroup>
          {confirmReal && provider === 'pey' && method === 'codi' ? (
            <Alert className="real-confirmation">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>Vas a generar un QR real por {money(parseMoney(amount) ?? 0)}</AlertTitle>
              <AlertDescription>Esta acción consulta Pey. El pago solo ocurre si alguien autoriza la transferencia en su banco.</AlertDescription>
              <div className="real-confirmation__actions">
                <Button variant="outline" onClick={() => setConfirmReal(false)}>Volver</Button>
                <Button onClick={submitOrder} disabled={busy || !stallVerified}>Confirmar y generar QR</Button>
              </div>
            </Alert>
          ) : (
            <Button size="lg" className="create-button" onClick={submitOrder} disabled={busy || !stallVerified}>
              {busy ? 'Espera…' : method === 'cash' ? 'Registrar efectivo' : provider === 'pey' ? 'Preparar QR real' : 'Crear orden de prueba'}
              {!busy && <ArrowRight aria-hidden="true" />}
            </Button>
          )}
          <p className="action-message" role="status" aria-live="polite">{actionMessage}</p>
          {lastCreated?.secretWord && <div className="private-word" role="status">
            <span><LockKeyhole size={16} aria-hidden="true" /> Palabra privada de la orden {lastCreated.number}</span>
            <strong>{lastCreated.secretWord}</strong>
          </div>}
        </CardContent>
      </Card>

      <section className="order-section" aria-labelledby="orders-heading">
        <div className="order-section__heading">
          <div>
            <p className="surface-label">Actividad</p>
            <h2 id="orders-heading">Órdenes recientes</h2>
          </div>
          <Button variant="outline" size="sm" onClick={refreshOrders} aria-label="Actualizar órdenes"><RefreshCw aria-hidden="true" /> Actualizar</Button>
        </div>
        {listError && <p className="inline-error" role="alert">{listError}</p>}
        {!orders.length && !listError ? (
          <div className="orders-empty">Todavía no hay órdenes en este puesto. Crea una para empezar.</div>
        ) : (
          <div className="order-list">
            {orders.map((order) => {
              const active = ['AWAITING_PAYMENT', 'PENDING_UNKNOWN', 'CREATING'].includes(order.state)
              const canPayMock = provider === 'mock' && order.method === 'codi' && order.state === 'AWAITING_PAYMENT'
              const qrValid = order.expiresAt && new Date(order.expiresAt).getTime() > now
              return (
                <Card key={order.orderId} className="order-item">
                  <CardHeader className="order-item__header">
                    <div>
                      <CardTitle className="text-lg">Orden {order.number}</CardTitle>
                      <CardDescription>{money(order.amountCents)} · {order.method === 'cash' ? 'Efectivo' : 'CoDi'}</CardDescription>
                    </div>
                    <Badge variant={order.state === 'PAID' || order.state === 'PAID_CASH' ? 'default' : 'secondary'}>{privateState(order)}</Badge>
                  </CardHeader>
                  <CardContent className="order-item__content">
                    {order.secretWord && <p className="order-item__word"><LockKeyhole size={14} aria-hidden="true" /> Palabra privada: <strong>{order.secretWord}</strong></p>}
                    {order.state === 'AWAITING_PAYMENT' && order.qrPayload && qrValid && (
                      <div className="order-item__qr">
                        <QRCodeSVG value={order.qrPayload} size={104} marginSize={1} title={provider === 'mock' ? 'QR simulado' : 'QR CoDi real'} />
                        <span>{provider === 'mock' ? 'QR simulado' : 'QR de Pey'}</span>
                      </div>
                    )}
                    {active && order.expiresAt && <p className="order-item__time"><Clock3 size={14} aria-hidden="true" /> {qrValid ? 'Vence ' + new Date(order.expiresAt).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : 'El QR ya venció'}</p>}
                    {active && <div className="order-item__actions">
                      {canPayMock && <Button size="sm" onClick={() => orderAction(order, 'pay')} disabled={busy || !qrValid}><Check aria-hidden="true" /> Simular pago</Button>}
                      <Button size="sm" variant="outline" onClick={() => orderAction(order, 'cancel')} disabled={busy}>Cancelar orden</Button>
                    </div>}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
