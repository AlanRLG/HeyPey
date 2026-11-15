import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Clock3, Loader2, Volume2, VolumeX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { configured, money, publicOrders, stateLabel, type Provider, type PublicOrder } from '@/lib/api'

type Props = {
  provider: Provider
  compact?: boolean
}

export function CustomerPanel({ provider, compact = false }: Props) {
  const [orders, setOrders] = useState<PublicOrder[]>([])
  const [message, setMessage] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [sound, setSound] = useState(false)
  const [paidFocus, setPaidFocus] = useState<{ id: string; until: number } | null>(null)
  const [now, setNow] = useState(0)
  const prior = useRef(new Map<string, string>())
  const first = useRef(true)
  const soundRef = useRef(false)

  useEffect(() => { soundRef.current = sound }, [sound])
  useEffect(() => {
    if (!configured) return
    let mounted = true
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await publicOrders(provider)
        if (!mounted) return
        const next = new Map(result.orders.map((order) => [order.orderId, order.state]))
        if (!first.current) {
          const newlyPaid = result.orders.find((order) =>
            order.state === 'PAID' &&
            order.secretWord &&
            prior.current.get(order.orderId) !== 'PAID',
          )
          if (newlyPaid) {
            setPaidFocus({ id: newlyPaid.orderId, until: Date.now() + 20000 })
            if (soundRef.current && 'speechSynthesis' in window) {
              const speech = new SpeechSynthesisUtterance(
                'Orden ' + newlyPaid.number + ', ' + newlyPaid.secretWord + ', pagada',
              )
              speech.lang = 'es-MX'
              window.speechSynthesis.cancel()
              window.speechSynthesis.speak(speech)
            }
          }
        }
        prior.current = next
        first.current = false
        setOrders(result.orders)
        setMessage('')
        setLoaded(true)
      } catch (error) {
        if (mounted) setMessage(error instanceof Error ? error.message : 'Sin conexión con el servidor.')
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const interval = window.setInterval(refresh, 3000)
    return () => { mounted = false; window.clearInterval(interval) }
  }, [provider])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])

  const paidOrder = paidFocus && paidFocus.until > now
    ? orders.find((order) => order.orderId === paidFocus.id && order.state === 'PAID')
    : null
  const current = paidOrder ??
    orders.find((order) => ['AWAITING_PAYMENT', 'PENDING_UNKNOWN', 'CREATING'].includes(order.state)) ??
    orders.find((order) => order.state === 'PAID' && order.secretWord) ??
    orders.find((order) => order.state === 'PAID')
  const qrActive = Boolean(
    current?.state === 'AWAITING_PAYMENT' &&
    current.qrPayload &&
    current.expiresAt &&
    new Date(current.expiresAt).getTime() > now,
  )
  const secondsLeft = current?.expiresAt
    ? Math.max(0, Math.ceil((new Date(current.expiresAt).getTime() - now) / 1000))
    : 0

  const tone = message ? 'error' : !loaded ? 'idle' : !current ? 'idle' : current.state === 'PAID' ? 'paid' : 'wait'
  const isMock = provider === 'mock'

  return (
    <Card className={'customer-panel customer-panel--' + tone + (compact ? ' customer-panel--compact' : '')}>
      <CardHeader className="customer-panel__header">
        <div>
          <h2 className="customer-panel__title">Pantalla del cliente</h2>
          <p className="customer-panel__sub">Aquí aparece el pago confirmado.</p>
        </div>
        <Badge variant="outline" className={'customer-panel__badge ' + (isMock ? 'customer-panel__badge--mock' : 'customer-panel__badge--real')}>
          {isMock ? 'Demo · sin dinero real' : 'Pey · pago real'}
        </Badge>
      </CardHeader>
      <CardContent className="customer-panel__content">
        {message ? (
          <div className="customer-state customer-state--error" role="alert">
            <p>No pudimos consultar las órdenes.</p>
            <p className="customer-state__sub">{message} Seguimos intentando cada 3 segundos.</p>
          </div>
        ) : !loaded ? (
          <div className="customer-state" role="status">
            <Loader2 className="customer-state__spinner" aria-hidden="true" />
            <p>Conectando con el servidor…</p>
          </div>
        ) : !current ? (
          <div className="customer-state" role="status">
            <span className="customer-state__ring" aria-hidden="true" />
            <p>Esperando un cobro</p>
            <p className="customer-state__sub">Cuando el comerciante cree una orden, verás aquí el importe y el QR.</p>
          </div>
        ) : current.state === 'PAID' && current.secretWord ? (
          <div className="customer-state customer-state--paid" role="status" aria-live="polite">
            <span className="customer-state__pill customer-state__pill--paid"><Check aria-hidden="true" /> Pago confirmado</span>
            <span className="customer-state__order">Orden {current.number}</span>
            <span className="customer-state__word">{current.secretWord}</span>
            <p className="customer-state__sub">Dile esta palabra al comerciante para recoger tu pedido.</p>
          </div>
        ) : current.state === 'PAID' ? (
          <div className="customer-state customer-state--paid" role="status" aria-live="polite">
            <span className="customer-state__pill customer-state__pill--paid"><Check aria-hidden="true" /> Pago confirmado</span>
            <span className="customer-state__order">Orden {current.number}</span>
            <strong className="customer-state__amount">{money(current.amountCents)}<small> MXN</small></strong>
            <p className="customer-state__sub">El servidor confirmó el pago. Esta orden no trae palabra pública.</p>
          </div>
        ) : (
          <div className="customer-state customer-state--waiting">
            <div className="customer-state__live" role="status">
              <span className="customer-state__pill customer-state__pill--wait"><Clock3 aria-hidden="true" /> {stateLabel[current.state] ?? 'Esperando confirmación'}</span>
              <span className="customer-state__order">Orden {current.number}</span>
              <strong className="customer-state__amount">{money(current.amountCents)}<small> MXN</small></strong>
            </div>
            {qrActive && current.qrPayload ? (
              <div className={'qr-frame ' + (isMock ? 'qr-frame--mock' : '')}>
                <QRCodeSVG value={current.qrPayload} size={compact ? 168 : 264} marginSize={1} title={isMock ? 'QR simulado' : 'QR CoDi de Pey'} />
                {isMock && <span className="qr-frame__stamp">SIMULADO</span>}
              </div>
            ) : (
              <div className="customer-state__pending">{stateLabel[current.state] ?? 'Esperando confirmación'}</div>
            )}
            <p className="customer-state__sub">
              {qrActive
                ? isMock
                  ? 'El comerciante activa el pago de prueba desde su pantalla.'
                  : 'Comprueba destinatario e importe en tu banco antes de autorizar.'
                : current.state === 'AWAITING_PAYMENT' && secondsLeft === 0
                  ? 'El QR venció. Espera una orden nueva.'
                  : 'El servidor está verificando el estado del pago.'}
            </p>
            {qrActive && <span className="customer-state__timer" role="timer">QR vigente · {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span>}
          </div>
        )}
      </CardContent>
      <div className="customer-panel__footer">
        <span>La palabra se libera solo después de la confirmación del servidor.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="customer-panel__sound"
          onClick={() => setSound((value) => !value)}
          aria-pressed={sound}
          aria-label="Anuncio por voz"
        >
          {sound ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
          Anuncio por voz
          <span className="customer-panel__sound-state" aria-hidden="true">{sound ? 'Activo' : 'Apagado'}</span>
        </Button>
      </div>
    </Card>
  )
}
