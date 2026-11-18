import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceFocusFilter, validVoiceSample, voiceSampleWav } from '../src/main/speech/voice-focus.ts'
import { SpeechEngine } from '../src/main/speech/engine.ts'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'
import { nonSpeechTranscript } from '../src/main/speech/noise.ts'

const config = { enabled: true, enrollModel: 'enroll', chunkModel: 'chunk', voiceSample: 'owner.wav' }

test('voice focus batches audio without dropping or duplicating irregular microphone chunks', () => {
  const sizes: number[] = []
  const filter = new VoiceFocusFilter(() => ({ run: ({ samples }) => { sizes.push(samples.length); return { samples: samples.map((x) => x * 0.5) } } }))
  filter.configure(config)
  const output = [filter.process(new Float32Array(800).fill(0.8)), filter.process(new Float32Array(800).fill(0.8)), filter.process(new Float32Array(960).fill(0.8))]
  assert.deepEqual(output.map((x) => x.length), [0, 1280, 1280])
  assert.deepEqual(sizes, [1280, 1280])
  assert.ok(output.slice(1).every((chunk) => chunk.every((x) => Math.abs(x - 0.4) < 1e-6)))
})

test('an enabled broken filter never passes original room audio through', () => {
  const filter = new VoiceFocusFilter(() => { throw new Error('load failed') })
  assert.throws(() => filter.configure(config))
  assert.throws(() => filter.process(new Float32Array(1600).fill(0.5)))
  filter.configure({ ...config, enabled: false })
  const raw = new Float32Array(800)
  assert.equal(filter.process(raw), raw)
})

test('invalid filter output is rejected and changing profiles discards buffered old audio', () => {
  let invalid = true
  const filter = new VoiceFocusFilter(() => ({ run: ({ samples }) => ({ samples: invalid ? new Float32Array([NaN]) : samples.slice() }) }))
  filter.configure(config)
  assert.throws(() => filter.process(new Float32Array(1280)))
  invalid = false
  filter.configure(config)
  filter.process(new Float32Array(800).fill(0.5))
  filter.configure({ ...config, voiceSample: 'new-owner.wav' })
  assert.equal(filter.process(new Float32Array(480)).length, 0)
})

test('owner WAV validation rejects short, malformed and non-finite samples', () => {
  const wav = voiceSampleWav(new Float32Array(16000 * 10).fill(0.1))
  assert.equal(validVoiceSample(wav), true)
  assert.equal(validVoiceSample(Buffer.alloc(44)), false)
  assert.throws(() => voiceSampleWav(new Float32Array(16000)))
  assert.throws(() => voiceSampleWav(new Float32Array(16000 * 3).fill(NaN)))
  wav.writeUInt32LE(0xffffffff, 40)
  assert.equal(validVoiceSample(wav), false)
})

test('background annotations are ignored while ordinary speech and explicit dictation remain intact', () => {
  for (const text of ['(indistinct chatter) [Music]', '[Music] Yeah.', 'ука [Music] [inaudible]', '(неразборчиво)', '[muzică]']) assert.equal(nonSpeechTranscript(text), true, text)
  for (const text of ['Включи музыку', 'What does music mean?', 'Напиши [Music]', 'scrie [Music]', 'Write (indistinct chatter)']) assert.equal(nonSpeechTranscript(text), false, text)
})

test('voice setup pauses room commands while still allowing an explicitly started recording', () => {
  const engine = new SpeechEngine('', () => ({ ...DEFAULT_SETTINGS }))
  const internal = engine as any
  const sent: any[] = []
  internal.worker = { postMessage: (m: any) => sent.push(m), terminate: async () => {} }
  engine.ready = true
  engine.prepareVoiceSample(true)
  engine.feed(new Float32Array(800).buffer)
  assert.equal(sent.filter((m) => m.type === 'audio').length, 0)
  internal.focusState = 'recording'
  engine.feed(new Float32Array(800).buffer)
  assert.equal(sent.filter((m) => m.type === 'audio').length, 1)
  internal.focusState = 'off'
  engine.prepareVoiceSample(false)
  engine.feed(new Float32Array(800).buffer)
  assert.equal(sent.filter((m) => m.type === 'audio').length, 2)
  engine.dispose()
})

test('recording is explicit, can be cancelled, and ignores a late recording result', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const base = mkdtempSync(join(tmpdir(), 'jarvis-voice-focus-'))
  const engine = new SpeechEngine(base, () => ({ ...DEFAULT_SETTINGS }))
  const internal = engine as any
  const messages: any[] = []
  internal.worker = { postMessage: (m: any) => messages.push(m), terminate: async () => {} }
  engine.ready = true
  t.after(() => {
    engine.dispose()
    rmSync(join(base, 'voice-focus/owner.wav'), { force: true })
    if (existsSync(join(base, 'voice-focus'))) rmdirSync(join(base, 'voice-focus'))
    rmdirSync(base)
  })
  assert.equal(engine.voiceFocusStatus().profile, false)
  assert.equal(messages.some((m) => m.type === 'focusRecord'), false)
  engine.beginVoiceSample()
  const id = messages.at(-1).id
  engine.cancelVoiceSample()
  internal.onWorker({ type: 'focusRecorded', id, generation: internal.generation, samples: new Float32Array(160000) })
  assert.equal(existsSync(join(base, 'voice-focus/owner.wav')), false)
  engine.beginVoiceSample()
  const current = messages.at(-1).id
  let saved = 0
  engine.on('voiceSampleSaved', () => saved++)
  internal.onWorker({ type: 'focusRecorded', id: current, generation: internal.generation, samples: new Float32Array(160000).fill(0.2) })
  assert.equal(saved, 1)
  assert.equal(validVoiceSample(readFileSync(join(base, 'voice-focus/owner.wav'))), true)
  assert.equal(engine.voiceFocusStatus().profile, true)
  t.mock.timers.tick(20_000)
  assert.notEqual(engine.voiceFocusStatus().error, 'microphone')
})
