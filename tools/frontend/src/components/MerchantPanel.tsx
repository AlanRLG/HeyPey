import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { QRCodeSVG } from 'qrcode.react'
import { ArrowRight, Check, CircleAlert, Clock3, LockKeyhole, RefreshCw } from 'lucide-react'
import './voice-amount.css'
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
import { centsToField } from '@/lib/money'
import { armHeyPey, detectSpeechMode, listenOnce, type SpeechHost, type SpeechMode } from '@/lib/speech-capture'
import { parseSpokenAmount } from '@/lib/spoken-amount'

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
  const [amountSource, setAmountSource] = useState<'manual' | 'spoken'>('manual')
  const [reviewCents, setReviewCents] = useState<number | null>(null)
  const [method, setMethod] = useState<'codi' | 'cash'>('codi')
  const [confirmReal, setConfirmReal] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null)
  const [now, setNow] = useState(0)
  const [speechMode, setSpeechMode] = useState<SpeechMode | 'checking'>('checking')
  const [listening, setListening] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const [consentTarget, setConsentTarget] = useState<'dictate' | 'wake'>('dictate')
  const [wakeEnabled, setWakeEnabled] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const sessionUserRef = useRef<string | null>(null)
  const methodRef = useRef(method)
  const listenEpoch = useRef(0)
  const listeningRef = useRef(false)
  const consentRef = useRef(false)
  const listenRef = useRef<{ cancel: () => void } | null>(null)
  const wakeRef = useRef<{ cancel: () => void } | null>(null)
  const wakeEnabledRef = useRef(false)
  const editedDuringListen = useRef(false)

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
          listenEpoch.current += 1
          listeningRef.current = false
          consentRef.current = false
          listenRef.current?.cancel()
          listenRef.current = null
          wakeEnabledRef.current = false
          wakeRef.current?.cancel()
          wakeRef.current = null
          setListening(false)
          setWakeEnabled(false)
          setConsentOpen(false)
          setConfirmReal(false)
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
    let active = true
    void detectSpeechMode().then((mode) => {
      if (active) setSpeechMode(mode)
    })
    return () => { active = false }
  }, [])

  useEffect(() => () => {
    listenEpoch.current += 1
    listeningRef.current = false
    listenRef.current?.cancel()
    listenRef.current = null
    wakeEnabledRef.current = false
    wakeRef.current?.cancel()
    wakeRef.current = null
  }, [])

  useEffect(() => {
    const suspend = () => {
      if (!document.hidden || !wakeEnabledRef.current) return
      stopCapture()
      setVoiceNote('HeyPEY se apagó al salir de la pestaña. Actívalo de nuevo para escuchar.')
    }
    document.addEventListener('visibilitychange', suspend)
    return () => document.removeEventListener('visibilitychange', suspend)
  }, [])

  useEffect(() => {
    if (listening) document.getElementById('dictate-cancel')?.focus()
  }, [listening])

  useEffect(() => {
    if (wakeEnabled) document.getElementById('wake-cancel')?.focus()
  }, [wakeEnabled])

  useEffect(() => {
    if (consentOpen) document.getElementById('dictate-accept')?.focus()
  }, [consentOpen])

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

  function stopCapture() {
    const wasListening = listeningRef.current
    listenEpoch.current += 1
    listeningRef.current = false
    consentRef.current = false
    const active = listenRef.current
    listenRef.current = null
    active?.cancel()
    wakeEnabledRef.current = false
    const wake = wakeRef.current
    wakeRef.current = null
    wake?.cancel()
    setListening(false)
    setWakeEnabled(false)
    setConsentOpen(false)
    if (wasListening) setVoiceNote('Dictado cancelado. Puedes escribir el importe.')
  }

  function applySpokenAmount(transcript: string): boolean {
    const parsed = parseSpokenAmount(transcript)
    if (!parsed.ok) {
      setVoiceNote(parsed.message)
      return false
    }
    setAmount(centsToField(parsed.cents))
    setAmountSource('spoken')
    setReviewCents(parsed.cents)
    setConfirmReal(false)
    setVoiceNote(
      parsed.mentionsCash && methodRef.current !== 'cash'
        ? 'La frase menciona efectivo. El método sigue igual. Elige Efectivo si quieres cambiarlo.'
        : 'Importe dictado. Revísalo antes de continuar.',
    )
    return true
  }

  function beginListen() {
    if (!session || !stallVerified || listeningRef.current || speechMode === 'checking' || speechMode === 'none') return
    const epoch = listenEpoch.current + 1
    listenEpoch.current = epoch
    listeningRef.current = true
    consentRef.current = false
    editedDuringListen.current = false
    setListening(true)
    setConsentOpen(false)
    setConfirmReal(false)
    setVoiceNote('Escuchando…')
    const handle = listenOnce(window as unknown as SpeechHost, {
      local: speechMode === 'local',
      onFinal: (transcript) => {
        if (epoch !== listenEpoch.current || editedDuringListen.current) return
        applySpokenAmount(transcript)
      },
      onError: (message) => {
        if (epoch !== listenEpoch.current) return
        if (message) setVoiceNote(message)
      },
      onEnd: () => {
        if (epoch !== listenEpoch.current) return
        listeningRef.current = false
        setListening(false)
        setVoiceNote((current) => current === 'Escuchando…' ? 'No se escuchó un importe. Puedes dictarlo otra vez o escribirlo.' : current)
      },
    })
    listenRef.current = handle
  }

  function dictate() {
    if (!session || !stallVerified || busy || listeningRef.current || wakeEnabledRef.current) return
    if (speechMode === 'remote') {
      consentRef.current = true
      setConsentTarget('dictate')
      setConsentOpen(true)
      return
    }
    if (speechMode === 'local') beginListen()
  }

  function beginWake() {
    if (!session || !stallVerified || busy || wakeEnabledRef.current || listeningRef.current || speechMode === 'none' || speechMode === 'checking') return
    const epoch = ++listenEpoch.current
    consentRef.current = false
    setConsentOpen(false)
    wakeEnabledRef.current = true
    editedDuringListen.current = false
    setWakeEnabled(true)
    setConfirmReal(false)
    setVoiceNote('HeyPEY está atento. Di «HeyPEY» y después el importe.')
    const handle = armHeyPey(window as unknown as SpeechHost, {
      local: speechMode === 'local',
      onWake: () => {
        if (epoch !== listenEpoch.current) return
        setVoiceNote('HeyPEY te escucha. Di el importe, por ejemplo «un centavo».')
      },
      onAmount: (text) => {
        if (epoch !== listenEpoch.current || editedDuringListen.current) return false
        const phrase = text.startsWith('cobrale ') ? text : 'Cóbrale ' + text
        return applySpokenAmount(phrase)
      },
      onError: (message) => {
        if (epoch === listenEpoch.current) setVoiceNote(message)
      },
      onEnd: () => {
        if (epoch !== listenEpoch.current) return
        wakeEnabledRef.current = false
        wakeRef.current = null
        setWakeEnabled(false)
      },
    })
    if (wakeEnabledRef.current) wakeRef.current = handle
  }

  function activateWake() {
    if (!session || !stallVerified || busy || listeningRef.current || wakeEnabledRef.current) return
    if (speechMode === 'remote') {
      consentRef.current = true
      setConsentTarget('wake')
      setConsentOpen(true)
      return
    }
    if (speechMode === 'local') beginWake()
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
    if (listeningRef.current || wakeEnabledRef.current || consentRef.current) {
      setActionMessage('Termina o cancela el dictado antes de crear la orden.')
      return
    }
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
    const source = amountSource === 'spoken' && reviewCents === cents ? 'spoken' : 'manual'
    try {
      const created = await createOrder(provider, cents, method, intent.key, source)
      localStorage.removeItem(intentStorage(provider))
      setOrders((old) => [created, ...old.filter((order) => order.orderId !== created.orderId)])
      setLastCreatedId(created.orderId)
      setAmount('')
      setAmountSource('manual')
      setReviewCents(null)
      setVoiceNote('')
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
          <Button variant="ghost" size="sm" onClick={() => { stopCapture(); void supabase?.auth.signOut({ scope: 'local' }) }}>Salir</Button>
        </CardHeader>
        <CardContent className="merchant-panel__body">
          {onProviderChange && (
            <div className="provider-picker">
              <span>Proveedor del puesto</span>
              <ToggleGroup type="single" value={provider} onValueChange={(value) => {
                if (value === 'mock' || value === 'pey') {
                  stopCapture()
                  setConfirmReal(false)
                  onProviderChange(value)
                }
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
                  onChange={(event) => {
                    if (wakeEnabledRef.current) stopCapture()
                    editedDuringListen.current = true
                    setAmount(event.target.value)
                    setAmountSource('manual')
                    setReviewCents(null)
                    setConfirmReal(false)
                  }}
                  aria-describedby={reviewCents != null && amountSource === 'spoken' ? 'amount-help voice-review' : 'amount-help'}
                />
                <span aria-hidden="true">MXN</span>
              </div>
              <p id="amount-help" className="field-hint">Usa hasta dos decimales. El servidor valida el límite permitido.</p>
              <div className="voice-block">
                {speechMode === 'none' && <p className="voice-note">Este navegador no dicta importes. Escribe el monto.</p>}
                {speechMode !== 'none' && speechMode !== 'checking' && (
                  listening ? (
                    <Button id="dictate-cancel" type="button" variant="outline" className="voice-dictate" onClick={stopCapture}>
                      Cancelar dictado
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" className="voice-dictate" onClick={dictate} disabled={!stallVerified || busy || wakeEnabled || consentOpen}>
                      Dictar importe
                    </Button>
                  )
                )}
                {speechMode !== 'none' && speechMode !== 'checking' && !listening && (
                  wakeEnabled ? (
                    <Button type="button" id="wake-cancel" variant="outline" className="voice-dictate" onClick={stopCapture}>
                      Apagar HeyPEY
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" className="voice-dictate" onClick={activateWake} disabled={!stallVerified || busy || consentOpen}>
                      Activar HeyPEY
                    </Button>
                  )
                )}
                {consentOpen && (
                  <Alert>
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>{consentTarget === 'wake' ? 'Activar HeyPEY' : 'Dictado del navegador'}</AlertTitle>
                    <AlertDescription>{consentTarget === 'wake'
                      ? 'Mientras HeyPEY esté activo, el navegador puede enviar lo que escucha a su servicio de reconocimiento. Se apaga al salir de esta pestaña. No guardamos audio ni transcripciones.'
                      : 'El navegador puede enviar tu voz a su servicio de reconocimiento. No guardamos audio ni transcripciones. También puedes escribir el importe.'}</AlertDescription>
                    <div className="voice-actions">
                      <Button id="dictate-accept" type="button" onClick={consentTarget === 'wake' ? beginWake : beginListen}>{consentTarget === 'wake' ? 'Aceptar y activar HeyPEY' : 'Aceptar y dictar'}</Button>
                      <Button type="button" variant="outline" onClick={() => { consentRef.current = false; setConsentOpen(false); document.getElementById('order-amount')?.focus() }}>Escribir el importe</Button>
                    </div>
                  </Alert>
                )}
                <p className="voice-note" role="status" aria-live="polite">{listening ? 'Escuchando…' : voiceNote}</p>
                {reviewCents != null && amountSource === 'spoken' && (
                  <p className="voice-review" id="voice-review" role="status">
                    <strong>{money(reviewCents)} MXN</strong>
                    <span>Revisa el importe antes de continuar.</span>
                  </p>
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel>Método de pago</FieldLabel>
              <ToggleGroup type="single" value={method} onValueChange={(value) => {
                if (value === 'codi' || value === 'cash') {
                  methodRef.current = value
                  setMethod(value)
                  setConfirmReal(false)
                }
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
                <Button onClick={submitOrder} disabled={busy || !stallVerified || listening || wakeEnabled || consentOpen}>Confirmar y generar QR</Button>
              </div>
            </Alert>
          ) : (
            <Button size="lg" className="create-button" onClick={submitOrder} disabled={busy || !stallVerified || listening || wakeEnabled || consentOpen}>
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
