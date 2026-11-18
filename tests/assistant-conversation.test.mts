import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Assistant } from '../src/main/assistant.ts'
import { Opencode } from '../src/main/opencode.ts'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

// Use the real coordinator methods with fake device/agent boundaries; no Electron window or PC input is started.
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const a = Object.setPrototypeOf(new EventEmitter(), Assistant.prototype) as any
  let epoch = 0
  let aborts = 0
  let resets = 0
  const calls: unknown[] = []
  const computer = { cancel: () => { epoch++ }, begin: () => epoch, check: (e: number) => { if (e !== epoch) throw new Error('cancelled') } }
  const speech = {
    conversation: false, commandDraft: false, setResponding() {}, speaking() {},
    cancelListen(end = true) { resets++; if (end) this.conversation = false },
    setConversation(on: boolean) { this.conversation = on }, listenFor() {}
  }
  Object.assign(a, {
    state: 'idle', speakingDepth: 0, speakAbort: { aborted: false }, playResolvers: new Map(),
    sayChain: Promise.resolve(), sayEpoch: 0, commandRevision: 0, inputPaused: false,
    interruption: Promise.resolve(), interruptionContext: '', spokenSentences: [], liveSteps: [],
    askResolve: null, askId: '', askQuestion: '', routinesRunning: 0, controlOn: false,
    pendingConfirms: new Map(), grantedThreads: new Set(), settings: () => ({ ...DEFAULT_SETTINGS }),
    emitStatus() {}, speech, overlay: { clear() {}, setControl: async () => {} },
    mcp: { computer, pause() { computer.cancel() } },
    win: { call: async (name: string, args: any) => { calls.push([name, args]) } },
    opencode: { isBusy: false, aborted: false, async abort() { aborts++; this.isBusy = false; this.aborted = true } },
    tts: { available: () => true, synth: async () => wav() }, xtts: { state: 'ready' }
  })
  return { a, speech, calls, aborts: () => aborts, resets: () => resets }
}

function wav() {
  const b = Buffer.alloc(64)
  b.write('RIFF')
  b.writeUInt32LE(24000, 24)
  b.writeUInt32LE(20, 40)
  return b
}

test('voice entry is local, does not require an AI call, and voice exit returns to standby', async (t) => {
  const f = fixture(t)
  const said: string[] = []
  f.a.say = async (text: string) => { said.push(text) }
  await f.a.handleCommand('Давай пообщаемся, Джарвис', 'voice', 'ru')
  assert.equal(f.speech.conversation, true)
  assert.equal(said.length, 1)
  await f.a.handleCommand('Джарвис, давай поговорим', 'voice', 'ru')
  assert.equal(said.length, 1) // no repeated greetings
  await f.a.handleCommand('Джарвис, закончим разговор', 'voice', 'ru')
  assert.equal(f.speech.conversation, false)
  assert.equal(f.a.state, 'idle')
  assert.equal(f.calls.length, 0)
})

test('voice mode activation never queues a competing wake acknowledgement', async (t) => {
  const f = fixture(t)
  f.a.say = async () => {}
  let acknowledgements = 0
  f.a.ack = async () => { acknowledgements++ }
  await f.a.onTranscript('Джарвис, давай пообщаемся', 'ru', true)
  assert.equal(f.speech.conversation, true)
  assert.equal(acknowledgements, 0)
})

test('speech onset cancels audio and work immediately while preserving microphone capture', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.state = 'speaking'
  f.a.speakingDepth = 1
  f.a.opencode.isBusy = true
  const abort = deferred<void>()
  f.a.opencode.abort = () => abort.promise
  let stops = 0
  f.a.on('stopPlayback', () => { stops++ })
  await f.a.onSpeech({ type: 'speech', on: true })
  assert.equal(stops, 1)
  assert.equal(f.resets(), 0)
  assert.equal(f.speech.conversation, true)
  assert.equal(f.a.state, 'listening')
  const next = f.a.handleCommand('громче', 'voice', 'ru')
  await flush()
  assert.equal(f.calls.length, 0) // wait for the old agent's abort acknowledgement
  f.a.opencode.isBusy = false
  abort.resolve()
  await next
  assert.equal(f.calls.length, 1)
})

test('an aborted turn never starts fallback speech from its unspoken old text', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.opencode.aborted = true
  f.a.lastWasVoice = true
  f.a.lastAssistantText = 'Старый ответ нельзя читать после перебивания.'
  let said = 0
  f.a.say = async () => { said++ }
  await f.a.onTurnEnd()
  assert.equal(said, 0)
  assert.equal(f.a.state, 'listening')
})

test('new speech is not blocked by slow synthesis of the interrupted answer', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  const oldAudio = deferred<Buffer>()
  f.a.tts.synth = (text: string) => text.includes('Старый') ? oldAudio.promise : Promise.resolve(wav())
  const played: string[] = []
  f.a.on('play', (req: any) => { played.push(req.id); f.a.onPlayEnded(req.id, true) })
  const old = f.a.say('Старый ответ долго готовится.')
  await flush()
  f.a.stopSpeaking()
  await f.a.say('Уточнённый ответ.')
  assert.equal(played.length, 1)
  assert.equal(f.a.state, 'listening')
  oldAudio.resolve(wav())
  await old
  assert.equal(played.length, 1)
  assert.equal(f.a.speakingDepth, 0)
  assert.deepEqual(f.a.spokenSentences, ['Уточнённый ответ.'])
})

test('an interrupted routine stops before subsequent steps', async (t) => {
  const f = fixture(t)
  const first = deferred<void>()
  f.a.win.call = async (name: string, args: unknown) => { f.calls.push([name, args]); await first.promise }
  const routine = f.a.runRoutine({ name: 'test', steps: [{ type: 'keys', keys: 'ctrl+l' }, { type: 'type', text: 'must not be typed' }] })
  await flush()
  f.a.interruptForSpeech()
  first.resolve()
  await routine
  assert.equal(f.calls.length, 1)
  assert.equal(f.a.routinesRunning, 0)
})

test('cancelling a key hold still releases the held key', async (t) => {
  const f = fixture(t)
  const routine = f.a.runRoutine({ name: 'test', steps: [{ type: 'hold', keys: 'w', ms: 1000 }] })
  await flush()
  f.a.interruptForSpeech()
  t.mock.timers.tick(50)
  await routine
  assert.deepEqual(f.calls.map((c: any) => c[0]), ['keydown', 'keyup'])
})

test('answering an active question stops its speech without aborting the awaiting agent', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.askResolve = () => {}
  f.a.speakingDepth = 1
  await f.a.onSpeech({ type: 'speech', on: true })
  assert.equal(f.aborts(), 0)
  assert.equal(f.a.speakingDepth, 0)
})

function opencodeFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const o = new Opencode(() => ({ ...DEFAULT_SETTINGS }), { mcpUrl: '', mcpToken: '' }, { current: null } as any) as any
  o.sessionId = 'session'
  o.status = 'ready'
  o.wake = async () => {}
  const requests: string[] = []
  o.req = async (_method: string, path: string) => { requests.push(path) }
  const events: any[] = []
  o.on('chat', (item: any) => events.push(item))
  return { o, requests, events, event: (type: string, properties: any) => o.onEvent({ type, properties: { sessionID: 'session', ...properties } }) }
}

test('real SSE coordinator ignores old replies and late idle until the new response arrives', async (t) => {
  const f = opencodeFixture(t)
  await f.o.send('first', '', 'voice')
  f.event('message.updated', { info: { id: 'u1', role: 'user' } })
  f.event('message.updated', { info: { id: 'a1', role: 'assistant', parentID: 'u1' } })
  await f.o.abort()
  await f.o.send('second', '', 'voice')
  f.event('session.idle', {})
  assert.equal(f.o.isBusy, true)
  f.event('message.part.updated', { part: { id: 'old', type: 'text', messageID: 'a1', text: 'OLD' } })
  f.event('message.updated', { info: { id: 'a-late', role: 'assistant', parentID: 'u1' } })
  f.event('message.updated', { info: { id: 'u2', role: 'user' } })
  f.event('message.updated', { info: { id: 'a2', role: 'assistant', parentID: 'u2' } })
  f.event('message.part.updated', { part: { id: 'new', type: 'text', messageID: 'a2', text: 'NEW' } })
  assert.deepEqual(f.events.map((e) => e.text), ['NEW'])
  f.event('session.idle', {})
  assert.equal(f.o.isBusy, false)
})

test('cancellation during agent warm-up prevents the old prompt from being sent', async (t) => {
  const f = opencodeFixture(t)
  const warm = deferred<void>()
  f.o.wake = () => warm.promise
  const send = f.o.send('old', '', 'voice')
  await f.o.abort()
  warm.resolve()
  await send
  assert.equal(f.requests.some((p) => p.endsWith('/prompt_async')), false)
})

test('a further utterance invalidates a queued command while the old abort is still pending', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.state = 'speaking'
  f.a.speakingDepth = 1
  const abort = deferred<void>()
  f.a.opencode.abort = () => abort.promise
  await f.a.onSpeech({ type: 'speech', on: true })
  const superseded = f.a.handleCommand('громче', 'voice', 'ru')
  await flush()
  await f.a.onSpeech({ type: 'speech', on: true })
  abort.resolve()
  await superseded
  await flush()
  assert.equal(f.calls.length, 0)
  await f.a.handleCommand('тише', 'voice', 'ru')
  assert.deepEqual((f.calls[0] as any)[1].action, 'down')
})

test('abort waits for prompt acceptance and discovers a parent not yet delivered by SSE', async (t) => {
  const f = opencodeFixture(t)
  const accepted = deferred<void>()
  const paths: string[] = []
  f.o.req = async (_method: string, path: string) => {
    paths.push(path)
    if (path.endsWith('/prompt_async')) return accepted.promise
    if (path.includes('/message?')) return [{ info: { id: 'u-before-sse', role: 'user' } }]
  }
  const sending = f.o.send('old', '', 'voice')
  await flush()
  const aborting = f.o.abort()
  await flush()
  assert.equal(paths.some((p) => p.endsWith('/abort')), false)
  accepted.resolve()
  await Promise.all([sending, aborting])
  await f.o.send('new', '', 'voice')
  f.event('message.updated', { info: { id: 'late', role: 'assistant', parentID: 'u-before-sse' } })
  f.event('message.part.updated', { part: { id: 'late-part', type: 'text', messageID: 'late', text: 'OLD' } })
  assert.equal(f.events.length, 0)
})

test('a live question answer keeps the conversation open and exit still works while a question is pending', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.say = async () => {}
  const first = f.a.askNow('Сохранить файл?', undefined, 25)
  await flush()
  await f.a.onTranscript('нет', 'ru')
  assert.equal(await first, 'нет')
  assert.equal(f.speech.conversation, true)
  const second = f.a.askNow('О чём поговорим?', undefined, 25)
  await flush()
  await f.a.onTranscript('Джарвис, закончим разговор', 'ru')
  assert.equal(await second, '')
  assert.equal(f.speech.conversation, false)
})

test('question timeout does not cut off an answer still being spoken or collected', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.say = async () => {}
  const answer = f.a.askNow('В какую папку?', undefined, 25)
  f.speech.commandDraft = true
  t.mock.timers.tick(37_000)
  assert.equal(typeof f.a.askResolve, 'function')
  f.a.resolveAsk('документы')
  assert.equal(await answer, 'документы')
})

test('interruption context records confirmed speech and completed steps, without claiming running steps succeeded', async (t) => {
  const f = fixture(t)
  f.speech.conversation = true
  f.a.speakingDepth = 1
  f.a.spokenSentences = ['Первая фраза прозвучала.']
  f.a.liveSteps = [{ id: '1', status: 'done', label: 'opened settings' }, { id: '2', status: 'run', label: 'typing pending' }]
  await f.a.onSpeech({ type: 'speech', on: true })
  assert.match(f.a.interruptionContext, /Первая фраза прозвучала/)
  assert.match(f.a.interruptionContext, /opened settings/)
  assert.doesNotMatch(f.a.interruptionContext, /typing pending/)
})

test('an unacknowledged abort stops the agent server before another request can resume it', async (t) => {
  const f = opencodeFixture(t)
  await f.o.send('old', '', 'voice')
  f.o.req = async () => { throw new Error('server not responding') }
  await f.o.abort()
  assert.equal(f.o.status, 'stopped')
  assert.equal(f.o.isBusy, false)
  assert.equal(f.o.aborted, true)
})
