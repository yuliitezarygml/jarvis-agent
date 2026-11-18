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

function fixture(text = 'давай пообщаемся') {
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
  runInNewContext(worker, {
    require: (name: string) => {
      if (name === 'worker_threads') return { parentPort: port }
      if (name === 'sherpa-onnx-node') return { Vad, OnlineRecognizer }
      throw new Error(`Unexpected worker dependency: ${name}`)
    },
    Float32Array, Date: { now: () => 1000 },
    setTimeout: () => 1, clearTimeout() {}
  })
  const send = (message: any) => port.emit('message', message)
  send({ type: 'init', generation: 1, aliases: ['джарвис'], wakeEnabled: true })
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
