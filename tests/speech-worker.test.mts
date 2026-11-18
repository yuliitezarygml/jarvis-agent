import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'

// Run the actual worker protocol with a deterministic VAD boundary, without models or a microphone.
const worker = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/main/speech/worker.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false
}).outputFiles[0].text

function fixture(text = 'давай пообщаемся', focusConfig?: object) {
  const port = new EventEmitter() as EventEmitter & { postMessage: (message: any) => void }
  const events: any[] = []
  port.postMessage = (message) => events.push(message)
  class Vad {
    detected = false
    segments: any[] = []
    acceptWaveform(samples: Float32Array) {
      const next = samples[0] > 0
      if (this.detected && !next) this.segments.push({ samples: new Float32Array(16000) })
      this.detected = next
    }
    isDetected() { return this.detected }
    isEmpty() { return !this.segments.length }
    front() { return this.segments[0] }
    pop() { this.segments.shift() }
    reset() { this.detected = false; this.segments = [] }
  }
  class OnlineRecognizer {
    createStream() { return { acceptWaveform() {} } }
    isReady() { return false }
    getResult() { return { text } }
  }
  class OnlineSpeechDenoiser {
    run({ samples }: { samples: Float32Array }) { return { samples: new Float32Array(samples.length) } }
  }
  runInNewContext(worker, {
    require: (name: string) => {
      if (name === 'worker_threads') return { parentPort: port }
      if (name === 'sherpa-onnx-node') return { Vad, OnlineRecognizer, OnlineSpeechDenoiser }
      throw new Error(`Unexpected worker dependency: ${name}`)
    },
    Float32Array, Date: { now: () => 1000 },
    setTimeout: () => 1, clearTimeout() {}
  })
  const send = (message: any) => port.emit('message', message)
  send({ type: 'init', generation: 1, aliases: ['джарвис'], wakeEnabled: true, focus: focusConfig })
  const phrase = () => {
    send({ type: 'audio', samples: new Float32Array(512 * 4).fill(0.2) })
    send({ type: 'audio', samples: new Float32Array(512) })
  }
  return { send, phrase, events }
}

test('a real user phrase ending just after an acknowledgement is still sent to ASR', () => {
  const f = fixture()
  f.send({ type: 'mode', mode: 'command', timeoutMs: 7000 })
  f.send({ type: 'speaking', on: false })
  f.phrase()
  const jobs = f.events.filter((e) => e.type === 'job')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].commandMode, true)
  assert.equal(jobs[0].partial, 'давай пообщаемся')
})

test('ordinary ambient speech retains wake verification after acknowledgement playback', () => {
  const f = fixture('сегодня хорошая погода')
  f.send({ type: 'speaking', on: false })
  f.phrase()
  const jobs = f.events.filter((e) => e.type === 'job')
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].commandMode, false)
  assert.equal(jobs[0].gateHit, false)
})

test('room audio filtered to silence never triggers speech onset, wake, partial text or ASR', () => {
  const f = fixture('джарвис', { enabled: true, enrollModel: 'model', chunkModel: 'model', voiceSample: 'owner.wav' })
  f.phrase()
  assert.equal(f.events.some((e) => ['speech', 'wake', 'partial', 'job'].includes(e.type)), false)
  assert.ok(f.events.some((e) => e.type === 'focusStatus' && e.state === 'ready'))
})

test('sample recording captures only after an explicit request and does not execute the recorded words', () => {
  const f = fixture('джарвис открой браузер')
  f.send({ type: 'focusRecord', id: 7 })
  f.send({ type: 'audio', samples: new Float32Array(16000 * 10).fill(0.2) })
  const result = f.events.find((e) => e.type === 'focusRecorded')
  assert.equal(result.id, 7)
  assert.equal(result.samples.length, 160000)
  assert.equal(f.events.some((e) => ['speech', 'wake', 'partial', 'job'].includes(e.type)), false)
})

test('silence cannot replace a saved sample and cancelling recording discards captured audio', () => {
  const f = fixture()
  f.send({ type: 'focusRecord', id: 8 })
  f.send({ type: 'audio', samples: new Float32Array(160000) })
  assert.equal(f.events.find((e) => e.type === 'focusRecorded').error, 'quiet')
  f.send({ type: 'focusRecord', id: 9 })
  f.send({ type: 'audio', samples: new Float32Array(16000).fill(0.2) })
  f.send({ type: 'focusCancel' })
  assert.equal(f.events.filter((e) => e.type === 'focusRecorded' && e.id === 9).length, 0)
})
