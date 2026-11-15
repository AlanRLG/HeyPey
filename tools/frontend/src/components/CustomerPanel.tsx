import { useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { Check, Volume2, VolumeX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { configured, money, publicOrders, stateLabel, type Provider, type PublicOrder } from '@/lib/api'

type Props = {
  provider: Provider
  compact?: boolean
}

export function CustomerPanel({ provider, compact = false }: Props) {
  const [orders, setOrders] = useState<PublicOrder[]>([])
  const [message, setMessage] = useState('')
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
    orders.find((order) => order.state === 'PAID' && order.secretWord)
  const qrActive = Boolean(
    current?.state === 'AWAITING_PAYMENT' &&
    current.qrPayload &&
    current.expiresAt &&
    new Date(current.expiresAt).getTime() > now,
  )
  const secondsLeft = current?.expiresAt
    ? Math.max(0, Math.ceil((new Date(current.expiresAt).getTime() - now) / 1000))
    : 0

  return (
    <Card className={'customer-panel ' + (compact ? 'customer-panel--compact' : '')}>
      <CardHeader className="customer-panel__header">
        <div>
          <p className="surface-label">Pantalla del cliente</p>
          <CardTitle className="text-lg">Aquí aparece el pago confirmado</CardTitle>
        </div>
        <Badge variant="outline" className="customer-panel__badge">
          {provider === 'mock' ? 'Demo sin dinero' : 'Pey · pago real'}
        </Badge>
      </CardHeader>
      <CardContent className="customer-panel__content">
        {message ? (
          <div className="customer-state" role="alert">
            <p>No pudimos consultar las órdenes.</p>
            <p className="customer-state__sub">{message}</p>
          </div>
        ) : !current ? (
          <div className="customer-state" role="status">
            <span className="customer-state__ring" aria-hidden="true" />
            <p>Esperando un cobro</p>
            <p className="customer-state__sub">Cuando el comerciante cree una orden, verás el monto aquí.</p>
          </div>
        ) : current.state === 'PAID' && current.secretWord ? (
          <div className="customer-state customer-state--paid" role="status" aria-live="polite">
            <span className="customer-state__order">Orden {current.number}</span>
            <span className="customer-state__word">{current.secretWord}</span>
            <span className="customer-state__paid"><Check size={18} aria-hidden="true" /> Pago confirmado</span>
            <p className="customer-state__sub">Dile esta palabra al comerciante para recoger tu pedido.</p>
          </div>
        ) : (
          <div className="customer-state customer-state--waiting" role="status">
            <span className="customer-state__order">Orden {current.number}</span>
            <strong className="customer-state__amount">{money(current.amountCents)}</strong>
            {qrActive && current.qrPayload ? (
              <div className={'qr-frame ' + (provider === 'mock' ? 'qr-frame--mock' : '')}>
                <QRCodeSVG value={current.qrPayload} size={compact ? 158 : 220} marginSize={1} title={provider === 'mock' ? 'QR simulado' : 'QR CoDi de Pey'} />
                {provider === 'mock' && <span className="qr-frame__stamp">SIMULADO</span>}
              </div>
            ) : (
              <div className="customer-state__pending">{stateLabel[current.state] ?? 'Esperando confirmación'}</div>
            )}
            <p className="customer-state__sub">
              {qrActive
                ? provider === 'mock'
                  ? 'El comerciante activa el pago de prueba desde su pantalla.'
                  : 'Comprueba destinatario e importe en tu banco antes de autorizar.'
                : current.state === 'AWAITING_PAYMENT' && secondsLeft === 0
                  ? 'El QR venció. Espera una orden nueva.'
                  : 'El servidor está verificando el estado del pago.'}
            </p>
            {qrActive && <span className="customer-state__timer">QR vigente · {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</span>}
          </div>
        )}
      </CardContent>
      <div className="customer-panel__footer">
        <span>La palabra se libera solo después de la confirmación del servidor.</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setSound((value) => !value)}
          aria-pressed={sound}
          aria-label={sound ? 'Desactivar anuncios de voz' : 'Activar anuncios de voz'}
        >
          {sound ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
          {sound ? 'Sonido activo' : 'Activar sonido'}
        </Button>
      </div>
    </Card>
  )
}
