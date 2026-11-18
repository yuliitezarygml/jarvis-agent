import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

// Run the real controller with fake process/worker boundaries. No native recognisers, Electron or microphone are started.
const source = stripTypeScriptTypes(readFileSync(new URL('../src/main/speech/engine.ts', import.meta.url), 'utf8'), { mode: 'transform' })
  .replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?$/gm, (_line, names, name) => `const {${names}} = imports[${JSON.stringify(name)}];`)
  .replace('export class SpeechEngine', 'class SpeechEngine')

function setup(t: any, options: { installed?: string[]; sttModel?: string; forkErrors?: number; sendError?: 'throw' | 'callback' } = {}) {
  const workers: any[] = []
  const children: any[] = []
  const events: any[] = []
  let forkAttempts = 0
  const settings = { wakePhrases: ['Джарвис'], wakeEnabled: true, wakeSensitivity: 0.7, sttModel: options.sttModel || 'parakeet-en', sttLanguage: 'auto' }
  const paths = { vad: '/models/vad', wakeDir: '/models/wake', parakeetDir: '/models/parakeet', gigaDir: '/models/giga', whisperDir: (kind: string) => `/models/whisper-${kind}` }
  const installed = new Set(options.installed || [paths.vad, paths.parakeetDir, paths.gigaDir])
  class FakeWorker extends EventEmitter {
    sent: any[] = []
    constructor() { super(); workers.push(this) }
    postMessage(message: any) { this.sent.push(message) }
    terminate() { return Promise.resolve(0) }
  }
  class FakeChild extends EventEmitter {
    stderr = new EventEmitter()
    sent: any[] = []
    killed = false
    send(message: any, callback?: (error: Error | null) => void) {
      this.sent.push(message)
      if (options.sendError === 'throw') throw new Error('IPC closed')
      const error = options.sendError === 'callback' ? new Error('IPC closed') : null
      if (callback) callback(error)
      else if (error) this.emit('error', error)
    }
    kill() { this.killed = true }
  }
  const Engine = runInNewContext(source + '\nSpeechEngine', {
    imports: {
      worker_threads: { Worker: FakeWorker },
      child_process: { fork: () => {
        forkAttempts++
        if (forkAttempts <= (options.forkErrors || 0)) throw new Error('fork failed')
        const child = new FakeChild()
        children.push(child)
        return child
      } },
      events: { EventEmitter }, path: { join }, fs: { existsSync: (path: string) => installed.has(path) }, '../models': { pathsFor: () => paths }
    },
    __dirname: '/speech', process: { env: {}, execPath: process.execPath }, console,
    setTimeout: () => ({}), clearTimeout: () => {}
  })
  const engine = new Engine('/data', () => settings)
  engine.on('event', (event: any) => events.push(event))
  t.after(() => engine.dispose())
  const job = () => workers.at(-1).emit('message', { type: 'job', samples: new Float32Array([0.1]), commandMode: true, gateHit: true, partial: '' })
  const ready = (child: any) => child.emit('message', { type: 'ready' })
  const jobs = (child: any) => child.sent.filter((m: any) => m.type === 'job')
  const complete = (child: any, id: number, text = 'команда') => {
    child.emit('message', { type: 'event', id, event: { type: 'transcript', text } })
    child.emit('message', { type: 'done', id, produced: true })
  }
  return { engine, workers, children, events, settings, paths, job, ready, jobs, complete, forkAttempts: () => forkAttempts }
}

test('a config change replays unconsumed audio and keeps queued jobs moving', (t) => {
  const f = setup(t)
  assert.equal(f.engine.start(), true)
  f.job()
  const old = f.children[0]
  f.ready(old)
  const firstId = f.jobs(old)[0].id
  f.job()
  f.settings.sttLanguage = 'en'
  f.engine.updateConfig()
  const current = f.children[1]
  assert.equal(old.killed, true)
  assert.equal(current.sent[0].cfg.language, 'en')
  // These delayed callbacks belong to a killed process and must not finish the replacement's work.
  f.complete(old, firstId, 'устаревший текст')
  old.emit('exit', 1)
  old.emit('error', new Error('late process error'))
  f.ready(current)
  assert.equal(f.jobs(current)[0].id, firstId)
  f.complete(current, firstId)
  assert.equal(f.jobs(current).length, 2)
  f.complete(current, f.jobs(current)[1].id)
  assert.equal(f.events.some((e) => e.text === 'устаревший текст'), false)
  assert.equal(f.events.some((e) => e.type === 'noResult'), false)
})

test('config changes never replay an already delivered transcript', (t) => {
  const f = setup(t)
  f.engine.start(); f.job(); f.ready(f.children[0])
  const id = f.jobs(f.children[0])[0].id
  f.children[0].emit('message', { type: 'event', id, event: { type: 'transcript', text: 'готово' } })
  f.engine.updateConfig()
  assert.equal(f.children.length, 1)
  f.job(); f.ready(f.children[1])
  assert.notEqual(f.jobs(f.children[1])[0].id, id)
  assert.equal(f.events.filter((e) => e.type === 'transcript').length, 1)
})

test('late worker exit and messages cannot detach the replacement worker', (t) => {
  const f = setup(t)
  f.engine.start()
  const old = f.workers[0]
  assert.equal(f.engine.restart(), true)
  const current = f.workers[1]
  current.emit('message', { type: 'ready' })
  old.emit('message', { type: 'job', samples: new Float32Array(1) })
  old.emit('message', { type: 'wake' })
  old.emit('error', new Error('old worker failure'))
  old.emit('exit', 1)
  f.engine.feed(new Float32Array([0.1]).buffer)
  assert.equal(f.engine.ready, true)
  assert.equal(current.sent.at(-1).type, 'audio')
  assert.equal(f.children.length, 0)
  assert.equal(f.events.some((e) => e.type === 'error'), false)
})

test('a crashed ASR job is retried once and a persistent crash releases the queue', (t) => {
  const f = setup(t)
  f.engine.start(); f.job(); f.ready(f.children[0])
  const id = f.jobs(f.children[0])[0].id
  f.children[0].emit('exit', 1)
  f.ready(f.children[1])
  assert.equal(f.jobs(f.children[1])[0].id, id)
  f.children[1].emit('exit', 1)
  assert.equal(f.children.length, 2)
  assert.equal(f.engine.asrLoaded, false)
  assert.equal(f.events.filter((e) => e.type === 'noResult').length, 1)
  f.job(); f.ready(f.children[2])
  assert.equal(f.jobs(f.children[2]).length, 1)
})

test('child startup errors are handled even without an exit event', (t) => {
  const f = setup(t)
  f.engine.start(); f.job()
  f.children[0].emit('error', new Error('spawn ENOENT'))
  f.ready(f.children[1])
  assert.equal(f.jobs(f.children[1]).length, 1)
  assert.equal(f.children[0].killed, true)
})

test('synchronous fork failures are bounded and the next request can recover', (t) => {
  const f = setup(t, { forkErrors: 2 })
  f.engine.start(); f.job()
  assert.equal(f.forkAttempts(), 2)
  assert.equal(f.events.filter((e) => e.type === 'noResult').length, 1)
  f.job(); f.ready(f.children[0])
  assert.equal(f.jobs(f.children[0]).length, 1)
})

for (const sendError of ['throw', 'callback'] as const) {
  test(`IPC ${sendError} failures do not leave a pending job or crash loop`, (t) => {
    const f = setup(t, { sendError })
    f.engine.start(); f.job()
    assert.equal(f.forkAttempts(), 2)
    assert.equal(f.engine.asrLoaded, false)
    assert.equal(f.events.filter((e) => e.type === 'noResult').length, 1)
  })
}

test('messages with a different job ID cannot complete or replace the active result', (t) => {
  const f = setup(t)
  f.engine.start(); f.job(); f.ready(f.children[0]); f.job()
  const child = f.children[0], id = f.jobs(child)[0].id
  f.complete(child, id + 100, 'wrong job')
  assert.equal(f.jobs(child).length, 1)
  assert.equal(f.events.some((e) => e.text === 'wrong job'), false)
  f.complete(child, id)
  assert.equal(f.jobs(child).length, 2)
})

test('unexpected active-worker failure cleans up ASR and releases the UI', (t) => {
  const f = setup(t)
  f.engine.start(); f.job(); f.ready(f.children[0])
  f.workers[0].emit('error', new Error('native worker failure'))
  assert.equal(f.engine.ready, false)
  assert.equal(f.engine.asrLoaded, false)
  assert.equal(f.children[0].killed, true)
  assert.equal(f.events.filter((e) => e.type === 'noResult').length, 1)
  assert.equal(f.engine.start(), true)
})

test('readiness and child configuration use an installed Parakeet fallback for missing Whisper', (t) => {
  const f = setup(t, { sttModel: 'whisper-turbo' })
  assert.equal(f.engine.missing().length, 0)
  f.engine.start(); f.job()
  assert.equal(f.children[0].sent[0].cfg.parakeetDir, f.paths.parakeetDir)
  assert.equal(f.children[0].sent[0].cfg.whisperDir, '')
})

test('an installed alternate Whisper is used when the selected Parakeet is absent', (t) => {
  const f = setup(t, { installed: ['/models/vad', '/models/whisper-small'] })
  assert.equal(f.engine.missing().length, 0)
  f.engine.start(); f.job()
  assert.equal(f.children[0].sent[0].cfg.whisperKind, 'small')
  assert.equal(f.children[0].sent[0].cfg.whisperDir, '/models/whisper-small')
  assert.equal(f.children[0].sent[0].cfg.parakeetDir, '')
})
