import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { armHeyPey, type SpeechHost } from '@/lib/speech-capture'
import { centsToField, money, parseMoney } from '@/lib/money'
import { parseSpokenAmount } from '@/lib/spoken-amount'
import './judge-demo.css'

type Stage = 'draft' | 'waiting' | 'paid'
const EXAMPLE_WORD = 'cajeta'

export function JudgeDemo() {
  const [amount, setAmount] = useState('0.01')
  const [chargedCents, setChargedCents] = useState<number | null>(null)
  const [stage, setStage] = useState<Stage>('draft')
  const [message, setMessage] = useState('')
  const [voiceAvailable] = useState(() => {
    if (typeof window === 'undefined') return false
    const host = window as unknown as SpeechHost
    return Boolean(host.SpeechRecognition ?? host.webkitSpeechRecognition)
  })
  const [voiceActive, setVoiceActive] = useState(false)
  const [consentOpen, setConsentOpen] = useState(false)
  const [voiceNote, setVoiceNote] = useState('')
  const voiceRef = useRef<{ cancel: () => void } | null>(null)
  const activeRef = useRef(false)

  useEffect(() => {
    const stopOnHidden = () => {
      if (!document.hidden || !activeRef.current) return
      activeRef.current = false
      voiceRef.current?.cancel()
      voiceRef.current = null
      setVoiceActive(false)
      setVoiceNote('La escucha se apagó al salir de la pestaña. Actívala de nuevo.')
    }
    document.addEventListener('visibilitychange', stopOnHidden)
    return () => {
      document.removeEventListener('visibilitychange', stopOnHidden)
      activeRef.current = false
      voiceRef.current?.cancel()
    }
  }, [])

  useEffect(() => {
    if (consentOpen) document.getElementById('judge-consent-accept')?.focus()
    else if (voiceActive) document.getElementById('judge-wake-off')?.focus()
  }, [consentOpen, voiceActive])

  function stopVoice() {
    activeRef.current = false
    voiceRef.current?.cancel()
    voiceRef.current = null
    setVoiceActive(false)
  }

  function beginWake() {
    if (stage !== 'draft' || activeRef.current || !voiceAvailable) return
    setConsentOpen(false)
    activeRef.current = true
    setVoiceActive(true)
    setVoiceNote('Escuchando «HeyPEY». Después di el importe.')
    const handle = armHeyPey(window as unknown as SpeechHost, {
      local: false,
      onWake: () => setVoiceNote('HeyPEY te escucha. Di el importe.'),
      onAmount: (text) => {
        const phrase = text.startsWith('cobrale ') ? text : 'Cóbrale ' + text
        const parsed = parseSpokenAmount(phrase)
        if (!parsed.ok) {
          setVoiceNote(parsed.message)
          return false
        }
        setAmount(centsToField(parsed.cents))
        setMessage('')
        setVoiceNote('Importe listo. Revísalo antes de crear el cobro de ejemplo.')
        return true
      },
      onError: setVoiceNote,
      onEnd: () => {
        activeRef.current = false
        voiceRef.current = null
        setVoiceActive(false)
      },
    })
    if (activeRef.current) voiceRef.current = handle
  }

  function createExample() {
    if (activeRef.current || consentOpen || stage !== 'draft') return
    const cents = parseMoney(amount)
    if (cents === null) {
      setMessage('Escribe un importe mayor que cero y con máximo dos decimales.')
      return
    }
    setChargedCents(cents)
    setStage('waiting')
    setMessage('Cobro de ejemplo creado. La palabra sigue oculta para el cliente.')
  }

  function reset() {
    stopVoice()
    setConsentOpen(false)
    setStage('draft')
    setChargedCents(null)
    setAmount('0.01')
    setMessage('')
    setVoiceNote('')
  }

  return <section className="judge-demo" aria-labelledby="judge-title">
    <div className="judge-demo__intro">
      <p className="judge-demo__eyebrow">Recorrido público · sin cuenta · sin dinero real</p>
      <h1 id="judge-title">Prueba HeyPEY en tres pasos.</h1>
      <p>Dicta o escribe un importe, crea un cobro de ejemplo y confirma un pago simulado. Observa cuándo aparece la palabra en la pantalla del cliente.</p>
      <ol className="judge-demo__steps">
        <li><strong>1.</strong> Di «HeyPEY, cóbrale un centavo» o escribe <strong>0.01</strong>.</li>
        <li><strong>2.</strong> Pulsa «Crear cobro de ejemplo».</li>
        <li><strong>3.</strong> Pulsa «Simular pago» y mira la pantalla del cliente.</li>
      </ol>
    </div>

    <div className="judge-demo__screens">
      <section className="judge-demo__screen judge-demo__merchant" aria-labelledby="judge-merchant">
        <p className="judge-demo__screen-label">Comerciante · vista privada</p>
        <h2 id="judge-merchant">Prepara el cobro</h2>
        <label className="judge-demo__label" htmlFor="judge-amount">Importe en MXN</label>
        <div className="judge-demo__amount"><span aria-hidden="true">$</span><Input id="judge-amount" inputMode="decimal" value={amount} disabled={stage !== 'draft'} onChange={event => { if (activeRef.current) stopVoice(); setAmount(event.target.value); setMessage('') }} /><span>MXN</span></div>
        {stage === 'draft' && <div className="judge-demo__voice">
          {voiceAvailable ? (voiceActive
            ? <Button id="judge-wake-off" variant="outline" onClick={stopVoice}>Apagar HeyPEY</Button>
            : <Button variant="outline" onClick={() => setConsentOpen(true)}>Activar HeyPEY</Button>)
            : <p>Este navegador no ofrece reconocimiento web. Escribe el importe para continuar.</p>}
          {consentOpen && <div className="judge-demo__consent" role="group" aria-label="Permiso para dictado">
            <p>Mientras HeyPEY esté activo, el navegador puede enviar la voz a su servicio de reconocimiento. Esta demo no guarda audio ni transcripciones.</p>
            <Button id="judge-consent-accept" onClick={beginWake}>Aceptar y activar</Button>
            <Button variant="ghost" onClick={() => setConsentOpen(false)}>Seguir escribiendo</Button>
          </div>}
          <p role="status" aria-live="polite">{voiceNote}</p>
        </div>}
        <Button className="judge-demo__primary" onClick={createExample} disabled={stage !== 'draft' || voiceActive || consentOpen}>Crear cobro de ejemplo</Button>
        {chargedCents !== null && <div className="judge-demo__private-word"><span>Palabra privada del comerciante</span><strong>{EXAMPLE_WORD}</strong></div>}
        {message && <p className="judge-demo__message" role="status">{message}</p>}
        {stage === 'waiting' && <Button variant="outline" onClick={() => { setStage('paid'); setMessage('Pago simulado confirmado. La palabra ya puede mostrarse al cliente.') }}>Simular pago</Button>}
        {stage === 'paid' && <Button variant="outline" onClick={reset}>Reiniciar recorrido</Button>}
      </section>

      <section className="judge-demo__screen judge-demo__customer" aria-labelledby="judge-customer">
        <p className="judge-demo__screen-label">Cliente · vista pública</p>
        <h2 id="judge-customer">{stage === 'paid' ? 'Pago confirmado' : stage === 'waiting' ? 'Esperando pago' : 'Listo para el cobro'}</h2>
        {chargedCents === null ? <p>El importe y el QR de ejemplo aparecerán aquí cuando el comerciante cree el cobro.</p> : <>
          <p className="judge-demo__total">{money(chargedCents)} <span>MXN</span></p>
          {stage === 'waiting' ? <>
            <div className="judge-demo__qr"><QRCodeSVG value={`HEYPEY|DEMO|NO_VALIDO|${chargedCents}`} size={176} title="QR ilustrativo, no válido para pagar" /></div>
            <p className="judge-demo__hidden">Palabra oculta hasta confirmar el pago.</p>
          </> : <div className="judge-demo__paid" role="status"><span>La palabra ahora es visible</span><strong>{EXAMPLE_WORD}</strong></div>}
        </>}
      </section>
    </div>
    <p className="judge-demo__truth">Este recorrido es una <strong>simulación local</strong>: el QR no es válido y ningún pago llega a Supabase o Pey. El backend Pey sí confirmó anteriormente una transferencia real de $0.01 por webhook. <Link to="/cliente?modo=pey">Ver la pantalla pública conectada a Pey</Link>.</p>
  </section>
}
