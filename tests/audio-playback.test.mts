import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackController, prepareAudioPlayback, type PreparedPlayback } from '../src/renderer/src/audio-playback.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function audioHarness(suspended = false) {
  const resume = deferred<void>()
  const decodes: ReturnType<typeof deferred<AudioBuffer>>[] = []
  const sources: { onended: (() => void) | null; started: number; stopped: number; disconnected: number; start: () => void; stop: () => void; disconnect: () => void }[] = []
  const started: string[] = []
  const ended: string[] = []
  const failures: unknown[] = []
  let effectDisposals = 0
  const ctx = {
    state: suspended ? 'suspended' : 'running',
    resume: async () => { await resume.promise; ctx.state = 'running' },
    decodeAudioData: () => {
      const decode = deferred<AudioBuffer>()
      decodes.push(decode)
      return decode.promise
    },
    createBufferSource: () => {
      const source = {
        onended: null as (() => void) | null,
        started: 0, stopped: 0, disconnected: 0,
        start: () => { source.started++ },
        stop: () => { source.stopped++; source.onended?.() },
        disconnect: () => { source.disconnected++ }
      }
      sources.push(source)
      return source
    }
  }
  const controller = new PlaybackController<{ id: string; wav: Uint8Array }>({
    prepare: (request, signal) => prepareAudioPlayback(ctx as unknown as AudioContext, request.wav, signal, () => () => { effectDisposals++ }),
    started: (request) => started.push(request.id),
    ended: (request) => ended.push(request.id),
    failed: (error) => failures.push(error)
  })
  return { controller, resume, decodes, sources, started, ended, failures, effectDisposals: () => effectDisposals, request: (id: string) => ({ id, wav: new Uint8Array([1, 2]) }) }
}

test('stop acknowledges pending decode immediately and prevents a later start', async () => {
  const h = audioHarness()
  const preparing = h.controller.play(h.request('stopped'))
  assert.equal(h.decodes.length, 1)
  h.controller.stop()
  assert.deepEqual(h.ended, ['stopped'])
  h.decodes[0].resolve({} as AudioBuffer)
  await preparing
  assert.equal(h.sources.length, 0)
  assert.deepEqual(h.started, [])
  assert.deepEqual(h.ended, ['stopped'])
})

test('stop during AudioContext resume prevents decoding and playback', async () => {
  const h = audioHarness(true)
  const preparing = h.controller.play(h.request('resume'))
  h.controller.stop()
  h.resume.resolve()
  await preparing
  assert.equal(h.decodes.length, 0)
  assert.equal(h.sources.length, 0)
  assert.deepEqual(h.ended, ['resume'])
})

test('out-of-order decodes only start the newest request', async () => {
  const h = audioHarness()
  const old = h.controller.play(h.request('old'))
  const latest = h.controller.play(h.request('latest'))
  h.decodes[1].resolve({} as AudioBuffer)
  await latest
  h.decodes[0].resolve({} as AudioBuffer)
  await old
  assert.equal(h.sources.length, 1)
  assert.deepEqual(h.started, ['latest'])
  assert.deepEqual(h.ended, ['old'])
  h.sources[0].onended?.()
  assert.deepEqual(h.ended, ['old', 'latest'])
  assert.equal(h.effectDisposals(), 1)
})

test('replacement stops the previous source, disposes its graph and ignores late ended events', async () => {
  const h = audioHarness()
  const first = h.controller.play(h.request('first'))
  h.decodes[0].resolve({} as AudioBuffer)
  await first
  const lateEnded = h.sources[0].onended
  const second = h.controller.play(h.request('second'))
  assert.equal(h.sources[0].stopped, 1)
  assert.equal(h.sources[0].disconnected, 1)
  assert.equal(h.effectDisposals(), 1)
  h.decodes[1].resolve({} as AudioBuffer)
  await second
  lateEnded?.()
  assert.deepEqual(h.ended, ['first'])
  h.controller.stop()
  h.controller.stop()
  assert.deepEqual(h.ended, ['first', 'second'])
  assert.equal(h.sources[1].disconnected, 1)
  assert.equal(h.effectDisposals(), 2)
})

test('decoder rejection reports the error and ends exactly once', async () => {
  const h = audioHarness()
  const preparing = h.controller.play(h.request('bad-audio'))
  const failure = new Error('invalid WAV')
  h.decodes[0].reject(failure)
  await preparing
  h.controller.stop()
  assert.deepEqual(h.failures, [failure])
  assert.deepEqual(h.ended, ['bad-audio'])
  assert.equal(h.sources.length, 0)
})

test('a late prepared sound is disposed even if its preparer ignores cancellation', async () => {
  const pending = deferred<PreparedPlayback>()
  let starts = 0, disposals = 0, ends = 0
  const controller = new PlaybackController({
    prepare: () => pending.promise,
    started: () => {}, ended: () => { ends++ }, failed: () => assert.fail('unexpected failure')
  })
  const preparing = controller.play({})
  controller.stop()
  pending.resolve({ start: () => { starts++ }, stop: () => {}, dispose: () => { disposals++ }, onEnded: () => {} })
  await preparing
  assert.equal(starts, 0)
  assert.equal(disposals, 1)
  assert.equal(ends, 1)
})
