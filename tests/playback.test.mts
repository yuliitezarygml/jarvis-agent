import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AudioPlayback } from '../src/renderer/src/playback.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function fixture() {
  const decodes: ReturnType<typeof deferred<any>>[] = []
  const sources: any[] = []
  const ended: unknown[] = []
  let stops = 0
  const ctx = {
    state: 'running', resume: async () => {},
    decodeAudioData: () => { const d = deferred<any>(); decodes.push(d); return d.promise },
    createBufferSource: () => {
      const src = { onended: () => {}, connect() {}, starts: 0, start() { this.starts++ }, stop() { this.onended() } }
      sources.push(src)
      return src
    }
  }
  const player = new AudioPlayback({ context: () => ctx as any, chain: () => ({ input: {} as any }), startLevels() {}, stopLevels() { stops++ }, ended: (id, completed) => ended.push([id, completed]) })
  const req = (id: string) => ({ id, wav: new Uint8Array(8), fx: false, volume: 1 })
  return { player, ctx, decodes, sources, ended, req, stops: () => stops }
}

test('stopping during audio decoding prevents the old clip from starting later', async () => {
  const f = fixture()
  const old = f.player.play(f.req('old'))
  f.player.stop()
  f.decodes[0].resolve({})
  await old
  assert.equal(f.sources.length, 0)
  assert.deepEqual(f.ended, [['old', false]])
})

test('a new reply starts without waiting for old decoding and old completion does not stop it', async () => {
  const f = fixture()
  const old = f.player.play(f.req('old'))
  const next = f.player.play(f.req('next'))
  f.decodes[1].resolve({})
  await next
  assert.equal(f.sources[0].starts, 1)
  const stops = f.stops()
  f.decodes[0].resolve({})
  await old
  assert.equal(f.stops(), stops)
  f.sources[0].onended()
  assert.deepEqual(f.ended, [['old', false], ['next', true]])
})

test('stopping playing audio reports an interruption rather than a fully heard sentence', async () => {
  const f = fixture()
  const play = f.player.play(f.req('one'))
  f.decodes[0].resolve({})
  await play
  f.player.stop()
  assert.deepEqual(f.ended, [['one', false]])
})

test('stopping while the audio context resumes prevents decoding and playback', async () => {
  const f = fixture()
  const resume = deferred<void>()
  f.ctx.state = 'suspended'
  f.ctx.resume = () => resume.promise
  const play = f.player.play(f.req('one'))
  f.player.stop()
  resume.resolve()
  await play
  assert.equal(f.decodes.length, 0)
  assert.deepEqual(f.ended, [['one', false]])
})
