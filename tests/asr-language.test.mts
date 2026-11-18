import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'

const source = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/main/speech/asr.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

function recognise(russian: string, multilingual: { text: string; lang: string }, commandMode = false, language = '') {
  const process = new EventEmitter() as EventEmitter & { send: (message: any) => void }
  const events: any[] = []
  let multilingualCalls = 0
  process.send = (message) => { if (message.type === 'event') events.push(message.event) }
  class OfflineRecognizer {
    constructor(private config: any) {}
    createStream() { return { acceptWaveform() {} } }
    decode() {}
    getResult() {
      if (this.config.modelConfig.nemoCtc) return { text: russian }
      multilingualCalls++
      return multilingual
    }
  }
  runInNewContext(source, {
    process, Float32Array,
    require: (name: string) => {
      assert.equal(name, 'sherpa-onnx-node')
      return { OfflineRecognizer }
    }
  })
  process.emit('message', { type: 'init', warm: true, cfg: {
    gigaDir: 'fake-ru', whisperDir: 'fake-whisper', whisperKind: 'base', parakeetDir: '', threads: 1, language
  } })
  process.emit('message', { type: 'job', id: 1, samples: new Float32Array(1600), commandMode,
    gateHit: false, partial: '', aliases: ['джарвис', 'jarvis'], sensitivity: 0.6, language })
  return { transcript: events.find((e) => e.type === 'transcript'), multilingualCalls }
}

test('actual ASR coordinator keeps a clear Russian wake command despite an incorrect English alternative', () => {
  const result = recognise('Джарис, давай пообщаемся.', { text: 'There is the web options.', lang: 'en' })
  assert.equal(result.transcript?.text, 'давай пообщаемся.')
  assert.equal(result.transcript?.lang, 'ru')
  assert.equal(result.multilingualCalls, 0)
})

test('verified name alone opens follow-up instead of being rejected by a wrong language guess', () => {
  const result = recognise('Джарвис.', { text: 'Jobs.', lang: 'en' })
  assert.equal(result.transcript?.text, '')
  assert.equal(result.transcript?.viaWake, true)
})

test('Russian continuation uses its clear result without needing the wake name', () => {
  const result = recognise('Давай пообщаемся.', { text: 'The web options.', lang: 'en' }, true)
  assert.equal(result.transcript?.text, 'Давай пообщаемся.')
  assert.equal(result.transcript?.lang, 'ru')
})

test('English and Romanian continuations still use multilingual recognition, and fixed RO takes priority', () => {
  for (const sample of [
    { text: 'Hello, tell me about the weather.', lang: 'en', russian: 'хеллоу', language: '' },
    { text: 'Bună! Hai să vorbim.', lang: 'ro', russian: 'хай са ворбим', language: '' },
    { text: 'Știință și țară.', lang: 'ro', russian: 'давай пообщаемся', language: 'ro' }
  ]) {
    const result = recognise(sample.russian, sample, true, sample.language)
    assert.equal(result.transcript?.text, sample.text)
    assert.equal(result.transcript?.lang, sample.lang)
    assert.equal(result.multilingualCalls, 1)
  }
})
