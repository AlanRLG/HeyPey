import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { detectSpeechMode, finalTranscriptFromEvent, LISTEN_LIMIT_MS, listenOnce } from './src/lib/speech-capture.ts'

test('un resultado parcial no entrega transcripción', () => {
  assert.equal(finalTranscriptFromEvent({
    results: { 0: { isFinal: false, 0: { transcript: 'Cóbrale doscientos' } }, length: 1 },
  }), null)
  assert.equal(finalTranscriptFromEvent({
    results: { 0: { isFinal: true, 0: { transcript: '  Cóbrale doscientos  ' } }, length: 1 },
  }), 'Cóbrale doscientos')
})

test('elige local solo si es-MX está disponible en el dispositivo', async () => {
  assert.equal(await detectSpeechMode({}), 'none')
  class Remote {
    static available() { return Promise.resolve('unavailable') }
  }
  class Local {
    static available(options) {
      assert.equal(options.processLocally, true)
      assert.deepEqual(options.langs, ['es-MX'])
      return Promise.resolve('available')
    }
  }
  assert.equal(await detectSpeechMode({ SpeechRecognition: Remote }), 'remote')
  assert.equal(await detectSpeechMode({ SpeechRecognition: Local }), 'local')
  class Broken {
    static available() { return Promise.reject(new Error('sin consulta')) }
  }
  assert.equal(await detectSpeechMode({ webkitSpeechRecognition: Broken }), 'remote')
})

test('cancelar ignora un resultado tardío y el error de micrófono no sigue escuchando', async () => {
  class Fake {
    start() {
      this.timer = setTimeout(() => {
        this.onresult?.({ results: { 0: { isFinal: true, 0: { transcript: 'Cóbrale cien' } }, length: 1 } })
        this.onend?.()
      }, 30)
    }
    abort() {
      clearTimeout(this.timer)
      setTimeout(() => {
        this.onresult?.({ results: { 0: { isFinal: true, 0: { transcript: 'Cóbrale doscientos' } }, length: 1 } })
      }, 10)
    }
  }
  let finals = 0
  const handle = listenOnce({ SpeechRecognition: Fake }, {
    local: true,
    onFinal: () => { finals += 1 },
    onError: () => { throw new Error('no debía fallar') },
    onEnd: () => {},
  })
  handle.cancel()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(finals, 0)

  class Denied {
    start() { this.onerror?.({ error: 'not-allowed' }); this.onend?.() }
    abort() {}
  }
  let message = ''
  let ended = 0
  listenOnce({ SpeechRecognition: Denied }, {
    local: false,
    onFinal: () => { throw new Error('no debía transcribir') },
    onError: (value) => { message = value },
    onEnd: () => { ended += 1 },
  })
  assert.match(message, /micrófono/)
  assert.equal(ended, 1)
})

test('dos resultados finales no reemplazan el primero', () => {
  class Double {
    start() {
      this.onresult?.({ results: { 0: { isFinal: true, 0: { transcript: 'Cóbrale doscientos' } }, length: 1 } })
      this.onresult?.({ results: { 0: { isFinal: true, 0: { transcript: 'Cóbrale mil' } }, length: 1 } })
      this.onend?.()
    }
    abort() { this.aborted = true }
  }
  const finals = []
  listenOnce({ SpeechRecognition: Double }, {
    local: false,
    onFinal: (transcript) => finals.push(transcript),
    onError: () => { throw new Error('no debía fallar') },
    onEnd: () => {},
  })
  assert.deepEqual(finals, ['Cóbrale doscientos'])
})

test('un reconocimiento que no termina vuelve al teclado e ignora un resultado tardío', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    let instance = null
    class Silent {
      constructor() { instance = this }
      start() {}
      abort() { this.aborted = true }
    }
    const finals = []
    let message = ''
    let ended = 0
    listenOnce({ SpeechRecognition: Silent }, {
      local: false,
      onFinal: (transcript) => finals.push(transcript),
      onError: (value) => { message = value },
      onEnd: () => { ended += 1 },
    })
    mock.timers.tick(LISTEN_LIMIT_MS)
    assert.match(message, /Repítelo o escribe el importe/)
    assert.equal(ended, 1)
    assert.equal(instance.aborted, true)
    instance.onresult?.({ results: { 0: { isFinal: true, 0: { transcript: 'Cóbrale cien' } }, length: 1 } })
    assert.deepEqual(finals, [])
  } finally {
    mock.timers.reset()
  }
})
