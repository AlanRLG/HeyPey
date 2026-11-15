export type SpeechMode = 'none' | 'local' | 'remote'

type SpeechAlternative = { transcript?: string }
type SpeechResult = { isFinal: boolean; 0?: SpeechAlternative }
type SpeechResultEvent = { results: ArrayLike<SpeechResult> }
type SpeechErrorEvent = { error?: string }

type SpeechInstance = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  processLocally?: boolean
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: ((event: SpeechErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  abort: () => void
}

type SpeechConstructor = {
  new (): SpeechInstance
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>
}

export type SpeechHost = {
  SpeechRecognition?: SpeechConstructor
  webkitSpeechRecognition?: SpeechConstructor
}

export const LISTEN_LIMIT_MS = 12_000

const ERRORS: Record<string, string> = {
  'not-allowed': 'El navegador no permitió el micrófono. Escribe el importe.',
  'service-not-allowed': 'El navegador no permitió el micrófono. Escribe el importe.',
  'audio-capture': 'No encontramos un micrófono. Escribe el importe.',
  network: 'Falló el reconocimiento del navegador. Escribe el importe o inténtalo de nuevo.',
  'no-speech': 'No se escuchó un importe. Puedes dictarlo otra vez o escribirlo.',
}

export function finalTranscriptFromEvent(event: SpeechResultEvent): string | null {
  const last = event.results[event.results.length - 1]
  if (!last?.isFinal) return null
  const text = last[0]?.transcript?.trim() ?? ''
  return text || null
}

function constructorOf(host: SpeechHost): SpeechConstructor | null {
  return host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null
}

export async function detectSpeechMode(host: SpeechHost = globalThis as unknown as SpeechHost): Promise<SpeechMode> {
  const Ctor = constructorOf(host)
  if (!Ctor) return 'none'
  if (typeof Ctor.available === 'function') {
    try {
      const status = await Ctor.available({ langs: ['es-MX'], processLocally: true })
      if (status === 'available') return 'local'
    } catch {
      // Sin consulta local el navegador queda en reconocimiento convencional.
    }
  }
  return 'remote'
}

export function listenOnce(
  host: SpeechHost,
  options: {
    local: boolean
    onFinal: (transcript: string) => void
    onError: (message: string) => void
    onEnd: () => void
  },
): { cancel: () => void } {
  const Ctor = constructorOf(host)
  if (!Ctor) {
    options.onError('Este navegador no puede dictar importes. Escribe el monto.')
    options.onEnd()
    return { cancel: () => {} }
  }
  const recognition = new Ctor()
  recognition.lang = 'es-MX'
  recognition.continuous = false
  recognition.interimResults = true
  recognition.maxAlternatives = 1
  if (options.local) recognition.processLocally = true
  let ignore = false
  let settled = false
  let delivered = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  const finish = () => {
    if (settled) return
    settled = true
    ignore = true
    clearTimer()
    options.onEnd()
  }
  recognition.onresult = (event) => {
    if (ignore || settled || delivered) return
    const transcript = finalTranscriptFromEvent(event)
    if (!transcript) return
    delivered = true
    clearTimer()
    options.onFinal(transcript)
    try { recognition.abort() } catch { /* el navegador ya cerró la escucha */ }
  }
  recognition.onerror = (event) => {
    if (ignore || settled) return
    const message = ERRORS[event.error ?? '']
    if (event.error === 'aborted') return
    options.onError(message ?? 'No se pudo dictar el importe. Escríbelo con el teclado.')
  }
  recognition.onend = finish
  timer = setTimeout(() => {
    if (settled || delivered) return
    ignore = true
    try { recognition.abort() } catch { /* ya estaba cerrado */ }
    options.onError('No se completó el dictado. Repítelo o escribe el importe.')
    finish()
  }, LISTEN_LIMIT_MS)
  try {
    recognition.start()
  } catch {
    options.onError('No se pudo abrir el micrófono. Escribe el importe.')
    finish()
  }
  return {
    cancel: () => {
      ignore = true
      clearTimer()
      try { recognition.abort() } catch { /* ya estaba cerrado */ }
      finish()
    },
  }
}
