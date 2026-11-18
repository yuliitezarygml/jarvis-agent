import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { CommandBuffer, needsContinuation, type CommandTranscript } from '../src/main/speech/command-buffer.ts'
import { SpeechEngine, type SpeechEvent } from '../src/main/speech/engine.ts'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'

const transcript = (text: string): CommandTranscript => ({ text, raw: text, lang: 'ru', viaWake: true, woke: true, ms: 50 })

class Clock {
  time = 1000
  timers = new Set<{ at: number; run: () => void }>()
  now = () => this.time
  after = (ms: number, run: () => void) => {
    const timer = { at: this.time + ms, run }
    this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }
  tick(ms: number) {
    const until = this.time + ms
    for (;;) {
      const timer = [...this.timers].filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      this.time = timer.at
      this.timers.delete(timer)
      timer.run()
    }
    this.time = until
  }
}

function bufferFixture(pause = 3500) {
  const clock = new Clock()
  const completed: CommandTranscript[] = []
  const expired: string[] = []
  const drafts: { text: string; waiting: boolean }[] = []
  const buffer = new CommandBuffer({
    clock, pauseMs: () => pause,
    complete: (t) => { completed.push(t) },
    expired: (reason) => { expired.push(reason) },
    draft: (text, waiting) => { drafts.push({ text, waiting }) }
  })
  return { buffer, clock, completed, expired, drafts }
}

test('complete commands wait for the configured pause and run exactly once', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой документы'))
  f.clock.tick(3499)
  assert.equal(f.completed.length, 0)
  f.clock.tick(1)
  assert.equal(f.completed[0].text, 'открой документы')
  f.clock.tick(120_000)
  assert.equal(f.completed.length, 1)
  assert.equal(f.expired.length, 0)
})

test('a 3-second thinking pause preserves the beginning and a spoken correction', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой'))
  f.clock.tick(3000)
  f.buffer.speech(true)
  f.clock.tick(6000) // never finalise while the user is still speaking
  assert.equal(f.completed.length, 0)
  f.buffer.speech(false)
  f.buffer.accept({ ...transcript('папку загрузок, нет, документы'), viaWake: false })
  f.clock.tick(3500)
  assert.equal(f.completed[0].text, 'открой папку загрузок, нет, документы')
  assert.equal(f.completed[0].viaWake, true)
})

test('new speech cancels the previous completion timer even before ASR returns', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой браузер'))
  f.clock.tick(3400)
  f.buffer.speech(true)
  f.clock.tick(10_000)
  f.buffer.pending(1)
  f.buffer.speech(false)
  f.clock.tick(10_000)
  assert.equal(f.completed.length, 0)
  f.buffer.accept(transcript('и найди документацию'))
  f.buffer.pending(0)
  f.clock.tick(0)
  assert.equal(f.completed[0].text, 'открой браузер и найди документацию')
})

test('abandoned incomplete thoughts expire without execution', () => {
  for (const text of ['открой', 'перенеси файл в', 'найди в интернете про', 'найди в интернете', 'move the file to']) {
    const f = bufferFixture()
    f.buffer.accept(transcript(text))
    f.clock.tick(19_999)
    assert.equal(f.completed.length, 0, text)
    f.clock.tick(1)
    assert.deepEqual(f.expired, ['incomplete'], text)
    assert.equal(f.completed.length, 0, text)
  }
})

test('local completion hints support Cyrillic endings and ordinary short commands', () => {
  for (const text of ['покажи', 'сделай копию для', 'открой папку и', 'нет', 'найди в интернете']) assert.ok(needsContinuation(text), text)
  for (const text of ['громче', 'покажи рабочий стол', 'открой документы', 'open chrome', 'как дела']) assert.equal(needsContinuation(text), false, text)
})

test('let me think extends the pause without becoming part of the command', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой браузер'))
  f.clock.tick(2000)
  f.buffer.speech(true)
  f.buffer.speech(false)
  f.buffer.accept(transcript('дай подумать'))
  f.clock.tick(10_000)
  assert.equal(f.completed.length, 0)
  f.buffer.speech(true)
  f.buffer.speech(false)
  f.buffer.accept(transcript('и найди погоду'))
  f.clock.tick(3500)
  assert.equal(f.completed[0].text, 'открой браузер и найди погоду')
})

test('cancel drops timers and a later command never reuses old text', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('удали файл'))
  f.buffer.cancel()
  f.clock.tick(30_000)
  assert.equal(f.completed.length, 0)
  assert.equal(f.clock.timers.size, 0)
  f.buffer.accept(transcript('покажи рабочий стол'))
  f.clock.tick(3500)
  assert.equal(f.completed[0].text, 'покажи рабочий стол')
})

test('standalone stop bypasses the normal pause, dictated stop does not', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой папку'))
  f.buffer.accept(transcript('стоп'))
  assert.deepEqual(f.completed.map((t) => t.text), ['стоп'])
  f.clock.tick(30_000)
  assert.equal(f.completed.length, 1)
  f.buffer.accept(transcript('напиши слово стоп'))
  assert.equal(f.completed.length, 1)
  f.clock.tick(3500)
  assert.equal(f.completed[1].text, 'напиши слово стоп')
})

test('explicit finish works only as a separate control phrase outside dictation', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой документы'))
  f.buffer.accept(transcript('дай подумать'))
  f.buffer.accept(transcript('всё, выполняй'))
  f.clock.tick(0)
  assert.equal(f.completed[0].text, 'открой документы')
  const d = bufferFixture()
  d.buffer.accept(transcript('напиши'))
  d.buffer.accept(transcript('команда закончена'))
  d.clock.tick(3500)
  assert.equal(d.completed[0].text, 'напиши команда закончена')
})

test('a control word in a separately recognised dictation chunk remains text', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('напиши'))
  f.buffer.accept(transcript('стоп'))
  f.clock.tick(3500)
  assert.equal(f.completed[0].text, 'напиши стоп')
  f.buffer.accept(transcript('напиши'))
  f.buffer.accept(transcript('отмени команду'))
  assert.equal(f.completed[1].text, 'отмени команду')
})

test('repeated dictated words are preserved and an oversized draft never executes', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('напиши да'))
  f.buffer.accept(transcript('да да'))
  f.clock.tick(3500)
  assert.equal(f.completed[0].text, 'напиши да да да')
  f.buffer.accept(transcript('а'.repeat(8001)))
  assert.deepEqual(f.expired, ['limit'])
  assert.equal(f.completed.length, 1)
})

test('the total session limit discards even a continuously speaking request', () => {
  const f = bufferFixture()
  f.buffer.accept(transcript('открой'))
  f.buffer.speech(true)
  f.clock.tick(120_000)
  assert.equal(f.completed.length, 0)
  assert.deepEqual(f.expired, ['limit'])
})

// Exercise the real worker/child message coordinator without microphone, model downloads or processes.
function engineFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const engine = new SpeechEngine('', () => ({ ...DEFAULT_SETTINGS }))
  const internal = engine as any
  const events: SpeechEvent[] = []
  const sent: any[] = []
  const workerMessages: any[] = []
  internal.child = { send: (m: any) => sent.push(m), kill() {} }
  internal.childReady = true
  internal.worker = { postMessage: (m: any) => workerMessages.push(m), terminate: async () => {} }
  engine.on('event', (e: SpeechEvent) => events.push(e))
  t.after(() => engine.dispose())
  const work = (m: any) => internal.onWorker({ generation: internal.generation, ...m })
  const job = (commandMode = false) => {
    work({ type: 'job', samples: new Float32Array(160), commandMode, gateHit: !commandMode, partial: '' })
    return internal.seq as number
  }
  const result = (id: number, text: string) => internal.onChild({ type: 'event', id, event: { type: 'transcript', ...transcript(text) } })
  const done = (id: number) => internal.onChild({ type: 'done', id })
  const output = () => events.filter((e) => e.type === 'transcript')
  return { engine, internal, events, sent, workerMessages, work, job, result, done, output }
}

test('engine holds queued continuation chunks and verifies the wake only once', (t) => {
  const f = engineFixture(t)
  const first = f.job()
  const continuation = f.job() // captured before the first wake has finished verification
  f.result(first, 'открой')
  f.done(first)
  assert.equal(f.sent[1].commandMode, true)
  t.mock.timers.tick(5000)
  assert.equal(f.output().length, 0)
  f.result(continuation, 'папку документов')
  f.done(continuation)
  t.mock.timers.tick(3500)
  assert.equal(f.output()[0].text, 'открой папку документов')
  assert.equal(f.output().length, 1)
})

test('a continuation captured during the wake-only follow-up handoff needs no second wake word', (t) => {
  const f = engineFixture(t)
  f.engine.on('event', (e: SpeechEvent) => {
    // The assistant opens a follow-up window after the recogniser confirms just the name.
    if (e.type === 'transcript' && !e.text) f.engine.listenFor(7)
  })
  const first = f.job()
  f.result(first, '')
  f.done(first)
  const next = f.job(false) // worker captured it before receiving the command-mode message
  assert.equal(f.sent.at(-1).commandMode, true)
  f.result(next, 'давай пообщаемся')
  f.done(next)
  t.mock.timers.tick(3500)
  assert.equal(f.output().at(-1)?.text, 'давай пообщаемся')
})

test('a late worker mode acknowledgement cannot close a newer follow-up window', (t) => {
  const f = engineFixture(t)
  f.engine.listenFor(7)
  f.work({ type: 'mode', mode: 'wake' }) // acknowledgement of an older mode request
  assert.equal(f.internal.mode, 'command')
  assert.equal(f.events.some((e) => e.type === 'mode' && e.mode === 'wake'), false)
  f.work({ type: 'mode', mode: 'wake', timedOut: true })
  assert.equal(f.internal.mode, 'wake') // a real silence timeout still works
})

test('a timeout belonging to an older listening window cannot close a new one', (t) => {
  const f = engineFixture(t)
  f.engine.listenFor(7)
  const previous = f.workerMessages.at(-1).modeVersion
  f.engine.listenFor(12)
  const current = f.workerMessages.at(-1).modeVersion
  f.work({ type: 'mode', mode: 'wake', timedOut: true, modeVersion: previous })
  assert.equal(f.internal.mode, 'command')
  f.work({ type: 'mode', mode: 'wake', timedOut: true, modeVersion: current })
  assert.equal(f.internal.mode, 'wake')
})

test('a wake acknowledgement echo is filtered while the ordinary follow-up stays open', (t) => {
  const f = engineFixture(t)
  f.engine.listenFor(7)
  f.engine.speaking(true, 'Слушаю, сэр.')
  f.engine.speaking(false)
  const echo = f.job(true)
  f.result(echo, 'Слушаю, сэр.')
  f.done(echo)
  t.mock.timers.tick(1000)
  assert.equal(f.engine.commandDraft, false)
  assert.equal(f.internal.mode, 'command')
  const next = f.job(true)
  f.result(next, 'давай пообщаемся')
  f.done(next)
  t.mock.timers.tick(3500)
  assert.deepEqual(f.output().map((e) => e.text), ['давай пообщаемся'])
})

test('engine never submits a draft while a new chunk is being recognised', (t) => {
  const f = engineFixture(t)
  const first = f.job()
  f.result(first, 'открой браузер')
  f.done(first)
  t.mock.timers.tick(3000)
  f.work({ type: 'speech', on: true })
  t.mock.timers.tick(1000)
  f.work({ type: 'speech', on: false })
  const next = f.job(true)
  t.mock.timers.tick(10_000)
  assert.equal(f.output().length, 0)
  f.result(next, 'и найди настройки')
  f.done(next)
  t.mock.timers.tick(0)
  assert.equal(f.output()[0].text, 'открой браузер и найди настройки')
})

test('cancel ignores old child and worker events, then accepts only a fresh command', (t) => {
  const f = engineFixture(t)
  const old = f.job()
  const oldGeneration = f.internal.generation
  f.engine.cancelListen()
  f.work({ type: 'job', generation: oldGeneration, samples: new Float32Array(160), commandMode: true })
  const fresh = f.job()
  f.result(old, 'удали всё')
  f.done(old)
  assert.equal(f.sent.length, 2)
  f.result(fresh, 'покажи рабочий стол')
  f.done(fresh)
  t.mock.timers.tick(3500)
  assert.equal(f.output().length, 1)
  assert.equal(f.output()[0].text, 'покажи рабочий стол')
})

test('an unrecognised continuation discards the entire draft instead of executing the beginning', (t) => {
  const f = engineFixture(t)
  const first = f.job()
  f.result(first, 'открой браузер')
  f.done(first)
  f.done(f.job(true))
  t.mock.timers.tick(30_000)
  assert.equal(f.output().length, 0)
  assert.ok(f.events.some((e) => e.type === 'inputExpired' && e.reason === 'recognition'))
})

test('an ignored background fragment preserves the user draft and never becomes a command', (t) => {
  const f = engineFixture(t)
  const first = f.job()
  f.result(first, 'открой')
  f.done(first)
  const noise = f.job(true)
  f.internal.onChild({ type: 'event', id: noise, event: { type: 'ignored', reason: 'noise' } })
  f.done(noise)
  assert.equal(f.engine.commandDraft, true)
  assert.equal(f.events.some((e) => e.type === 'inputExpired'), false)
  const next = f.job(true)
  f.result(next, 'папку документов')
  f.done(next)
  t.mock.timers.tick(3500)
  assert.deepEqual(f.output().map((e) => e.text), ['открой папку документов'])
})

test('a window timeout cannot close a draft or pending recognition', (t) => {
  const f = engineFixture(t)
  const id = f.job()
  f.work({ type: 'mode', mode: 'wake', timedOut: true })
  assert.equal(f.internal.mode, 'command')
  f.result(id, 'открой')
  f.done(id)
  f.work({ type: 'mode', mode: 'wake', timedOut: true })
  assert.equal(f.engine.commandDraft, true)
  assert.equal(f.internal.mode, 'command')
  assert.equal(f.output().length, 0)
})

test('question answers preserve their separate immediate echo-checking path', (t) => {
  const f = engineFixture(t)
  f.engine.listenFor(25, false)
  const id = f.job(true)
  f.result(id, 'да')
  assert.equal(f.output()[0].text, 'да')
  assert.equal(f.engine.commandDraft, false)
  f.done(id)
})

test('duplicate recognition delivery never duplicates words in the command', (t) => {
  const f = engineFixture(t)
  const id = f.job()
  f.result(id, 'открой документы')
  f.result(id, 'открой документы')
  f.done(id)
  t.mock.timers.tick(3500)
  assert.equal(f.output().length, 1)
  assert.equal(f.output()[0].text, 'открой документы')
})

test('conversation stays in command mode for several replies without a new wake phrase', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  for (const text of ['как дела', 'объясни проще']) {
    const id = f.job(true)
    f.result(id, text)
    f.done(id)
    t.mock.timers.tick(3500)
    assert.equal(f.engine.conversation, true)
    assert.equal(f.internal.mode, 'command')
    assert.equal(f.workerMessages.filter((m) => m.type === 'reset').at(-1).mode, 'command')
  }
  assert.deepEqual(f.output().map((x) => x.text), ['как дела', 'объясни проще'])
  f.engine.setConversation(false)
  assert.equal(f.internal.mode, 'wake')
})

test('a trailing wake name preserves the invitation before it', (t) => {
  const f = engineFixture(t)
  const id = f.job()
  f.internal.onChild({ type: 'event', id, event: { type: 'transcript', ...transcript(''), raw: 'Давай пообщаемся, Джарвис' } })
  f.done(id)
  t.mock.timers.tick(3500)
  assert.equal(f.output()[0].text, 'Давай пообщаемся, Джарвис')
})

test('conversation idle timeout waits for an active task and then exits to wake mode', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  f.engine.setResponding(true)
  t.mock.timers.tick(240_000)
  assert.equal(f.engine.conversation, true)
  f.engine.setResponding(false)
  t.mock.timers.tick(119_999)
  assert.equal(f.engine.conversation, true)
  t.mock.timers.tick(1)
  assert.equal(f.engine.conversation, false)
  assert.equal(f.internal.mode, 'wake')
  assert.ok(f.events.some((e) => e.type === 'conversation' && e.reason === 'idle'))
})

test('a separate wait request pauses the conversation without becoming an executable command', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  const id = f.job(true)
  f.result(id, 'подожди')
  f.done(id)
  t.mock.timers.tick(30_000)
  assert.equal(f.engine.commandDraft, false)
  assert.equal(f.engine.conversation, true)
  assert.equal(f.output().length, 0)
  assert.ok(f.events.some((e) => e.type === 'conversationPause'))
})

test('speech onset is delivered before ASR, and an echoed answer never creates a new command', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  f.engine.speaking(true, 'Открой настройки звука и выбери нужный микрофон')
  f.work({ type: 'speech', on: true })
  assert.ok(f.events.some((e) => e.type === 'speech' && e.on))
  f.work({ type: 'speech', on: false })
  const id = f.job(true)
  f.result(id, 'Открой настройки звука и выбери нужный микрофон')
  f.done(id)
  t.mock.timers.tick(3500)
  assert.equal(f.output().length, 0)
  assert.equal(f.engine.commandDraft, false)
})

test('a live yes/no answer uses pause protection and keeps the conversation open', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  f.engine.listenFor(25, true, true)
  const id = f.job(true)
  f.result(id, 'нет')
  f.done(id)
  t.mock.timers.tick(3499)
  assert.equal(f.output().length, 0)
  t.mock.timers.tick(1)
  assert.equal(f.output()[0].text, 'нет')
  assert.equal(f.engine.conversation, true)
})

test('slow ASR still filters echo using the audio capture time', (t) => {
  const f = engineFixture(t)
  f.engine.setConversation(true)
  const line = 'Открой настройки звука и выбери нужный микрофон'
  f.engine.speaking(true, line)
  const id = f.job(true)
  f.engine.speaking(false)
  t.mock.timers.tick(10_000)
  f.result(id, line)
  f.done(id)
  t.mock.timers.tick(3500)
  assert.equal(f.output().length, 0)
})
