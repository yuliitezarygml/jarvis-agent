import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const nextMicrotask = async () => { await Promise.resolve(); await Promise.resolve() }

function microphoneHarness() {
  const requests: ReturnType<typeof deferred<MediaStream>>[] = []
  const modules: ReturnType<typeof deferred<void>>[] = []
  const contexts: { state: string; closes: number }[] = []
  const statuses: { state: string; deviceId: string; error?: string }[] = []
  const handlers = new Map<string, (...args: any[]) => void>()
  const timers = new Map<number, () => void>()
  const revoked: string[] = []
  let nextTimer = 0
  const IPC = { settingsGet: 'settings:get', settingsChanged: 'settings:changed', micStatus: 'audio:status', micStatusRequest: 'audio:status-request' }
  const api = {
    invoke: async () => ({ micDeviceId: 'first' }),
    on: (channel: string, handler: (...args: any[]) => void) => handlers.set(channel, handler),
    send: (channel: string, status: any) => { if (channel === IPC.micStatus) statuses.push(status) }
  }
  const audioNode = () => ({ gain: { value: 0 }, connect: (destination: any) => destination, disconnect: () => {} })
  class FakeAudioContext {
    state = 'running'
    closes = 0
    destination = audioNode()
    audioWorklet = { addModule: () => { const pending = deferred<void>(); modules.push(pending); return pending.promise } }
    constructor() { contexts.push(this) }
    close() { this.closes++; this.state = 'closed'; return Promise.resolve() }
    createMediaStreamSource() { return audioNode() }
    createGain() { return audioNode() }
  }
  class FakeAudioWorkletNode {
    port = { onmessage: null }
    connect = (destination: any) => destination
    disconnect = () => {}
  }
  const source = readFileSync(new URL('../src/renderer/src/audio.tsx', import.meta.url), 'utf8').replace(/^import .*$/gm, '').replace(/void main\(\)\s*$/, '')
  const compiled = stripTypeScriptTypes(source)
  const context = {
    module: { exports: {} }, api, IPC,
    PlaybackController: class { play() {}; stop() {} },
    AudioContext: FakeAudioContext, AudioWorkletNode: FakeAudioWorkletNode, Blob,
    URL: { createObjectURL: () => `blob:${modules.length}`, revokeObjectURL: (url: string) => revoked.push(url) },
    navigator: { mediaDevices: { getUserMedia: () => { const pending = deferred<MediaStream>(); requests.push(pending); return pending.promise } } },
    console: { error: () => {} },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: (id: number) => timers.delete(id)
  }
  vm.runInNewContext(compiled + '\nmodule.exports = { main };', context)
  const renderer = context.module.exports as { main: () => Promise<void> }
  const stream = () => {
    const listeners = new Set<() => void>()
    const track = {
      stops: 0, readyState: 'live', stop: () => { track.stops++; track.readyState = 'ended' },
      addEventListener: (_type: string, callback: () => void) => listeners.add(callback),
      removeEventListener: (_type: string, callback: () => void) => listeners.delete(callback),
      end: () => { track.readyState = 'ended'; for (const callback of [...listeners]) callback() },
      listeners
    }
    return { track, value: { getTracks: () => [track] } as unknown as MediaStream }
  }
  return { renderer, requests, modules, contexts, statuses, handlers, timers, revoked, stream, settings: (deviceId: string) => handlers.get(IPC.settingsChanged)!({ micDeviceId: deviceId }) }
}

test('late permission result from the old microphone is released and cannot replace the selected device', async () => {
  const h = microphoneHarness()
  const boot = h.renderer.main()
  await nextMicrotask()
  h.settings('second')
  const first = h.stream(), second = h.stream()
  h.requests[0].resolve(first.value)
  await boot
  assert.equal(first.track.stops, 1)
  assert.equal(h.contexts.length, 0)
  h.requests[1].resolve(second.value)
  await nextMicrotask()
  h.modules[0].resolve()
  await nextMicrotask()
  assert.deepEqual(h.statuses.map(({ state, deviceId }) => ({ state, deviceId })), [
    { state: 'starting', deviceId: 'first' }, { state: 'starting', deviceId: 'second' }, { state: 'ready', deviceId: 'second' }
  ])
  h.handlers.get('audio:status-request')!()
  assert.equal(h.statuses.at(-1)?.state, 'ready')
  assert.equal(h.statuses.at(-1)?.deviceId, 'second')
})

test('switching devices during worklet loading closes the old context and suppresses its error', async () => {
  const h = microphoneHarness()
  const boot = h.renderer.main()
  await nextMicrotask()
  const first = h.stream()
  h.requests[0].resolve(first.value)
  await nextMicrotask()
  h.settings('second')
  assert.equal(h.contexts[0].closes, 1)
  h.modules[0].reject(new Error('old context closed'))
  await boot
  assert.equal(h.statuses.some((status) => status.state === 'error'), false)
  const second = h.stream()
  h.requests[1].resolve(second.value)
  await nextMicrotask()
  h.modules[1].resolve()
  await nextMicrotask()
  assert.equal(h.statuses.at(-1)?.state, 'ready')
  assert.equal(h.statuses.at(-1)?.deviceId, 'second')
  assert.equal(h.revoked.length, 2)
})

test('microphone failure is reported, and changing devices cancels the stale retry', async () => {
  const h = microphoneHarness()
  const boot = h.renderer.main()
  await nextMicrotask()
  h.requests[0].reject(new Error('microphone permission denied'))
  await boot
  assert.equal(h.statuses.at(-1)?.state, 'error')
  assert.match(h.statuses.at(-1)?.error ?? '', /permission denied/)
  assert.equal(h.timers.size, 1)
  h.settings('second')
  assert.equal(h.timers.size, 0)
  assert.equal(h.statuses.at(-1)?.state, 'starting')
  assert.equal(h.statuses.at(-1)?.deviceId, 'second')
})

test('an unplugged microphone reports an error and retries without accepting late old track events', async () => {
  const h = microphoneHarness()
  const boot = h.renderer.main()
  await nextMicrotask()
  const first = h.stream()
  h.requests[0].resolve(first.value)
  await nextMicrotask()
  h.modules[0].resolve()
  await boot
  const lateEnded = [...first.track.listeners][0]
  assert.equal(h.statuses.at(-1)?.state, 'ready')
  first.track.end()
  assert.equal(h.statuses.at(-1)?.state, 'error')
  assert.match(h.statuses.at(-1)?.error ?? '', /disconnected/)
  assert.equal(h.contexts[0].closes, 1)
  assert.equal(first.track.listeners.size, 0)
  const retry = [...h.timers.values()][0]
  h.timers.clear()
  retry()
  assert.equal(h.requests.length, 2)
  assert.equal(h.statuses.at(-1)?.state, 'starting')
  const second = h.stream()
  h.requests[1].resolve(second.value)
  await nextMicrotask()
  h.modules[1].resolve()
  await nextMicrotask()
  assert.equal(h.statuses.at(-1)?.state, 'ready')
  const statusCount = h.statuses.length
  lateEnded()
  assert.equal(h.statuses.length, statusCount)
  assert.equal(h.contexts[1].closes, 0)
})
