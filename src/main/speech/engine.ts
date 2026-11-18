import { Worker } from 'worker_threads'
import { fork, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Settings } from '../../shared/types'
import { pathsFor } from '../models'

export type SpeechEvent =
  | { type: 'ready' }
  | { type: 'error'; error: string; soft?: boolean }
  | { type: 'speech'; on: boolean }
  | { type: 'partial'; text: string }
  | { type: 'wake'; text: string }
  | { type: 'wakeRejected'; text: string }
  | { type: 'busy'; on: boolean }
  | { type: 'noResult' }
  | { type: 'mode'; mode: 'wake' | 'command'; timedOut?: boolean }
  | { type: 'transcript'; text: string; raw: string; woke: boolean; ms: number; viaWake: boolean; lang: string }

interface Job {
  id: number
  samples: Float32Array
  commandMode: boolean
  gateHit: boolean
  partial: string
}

/** The big recognisers exit after this long without work, returning ~550 MB to the OS. */
const CHILD_IDLE_MS = Number(process.env.JARVIS_ASR_IDLE_MS) || 60_000

/**
 * Two parts:
 *  - a worker thread with VAD + a tiny streaming wake gate (always on, ~200 MB)
 *  - an ASR child process (GigaAM-RU + Whisper) spawned when speech starts and killed when idle
 */
export class SpeechEngine extends EventEmitter {
  private worker: Worker | null = null
  private mode: 'wake' | 'command' = 'wake'
  private child: ChildProcess | null = null
  private childReady = false
  private childIdle: NodeJS.Timeout | null = null
  private queue: Job[] = []
  private inFlight: Job | null = null
  private produced = false
  private childFailures = 0
  private seq = 0
  ready = false

  constructor(
    private base: string,
    private getSettings: () => Settings
  ) {
    super()
  }

  missing(): string[] {
    const p = pathsFor(this.base)
    const s = this.getSettings()
    const miss: string[] = []
    if (!existsSync(p.vad)) miss.push('silero-vad')
    if (!p.wakeDir) miss.push('wake-ru-zipformer')
    // Use the same fallback selection here and when the child is configured.
    const en = englishRecognizer(p, s)
    const haveEn = !!(en.parakeetDir || en.whisperDir)
    if (!haveEn) miss.push('parakeet-en')
    return miss
  }

  private aliases() {
    const s = this.getSettings()
    const base = s.wakePhrases.map((x) => x.toLowerCase().trim()).filter(Boolean)
    // the recognisers write the default name many ways; accept the common ones without asking the user to list them
    const jarvis = ['джарвис', 'jarvis', 'жарвис'].some((a) => base.includes(a))
    const extra = jarvis ? ['джарви', 'джави', 'жарви', 'джарвиз', 'джервис', 'джарвес'] : []
    return Array.from(new Set([...base, ...extra]))
  }

  start() {
    if (this.worker || this.missing().length) return false
    const p = pathsFor(this.base)
    const s = this.getSettings()
    let w: Worker
    try {
      w = new Worker(join(__dirname, 'speechWorker.js'))
    } catch (e) {
      this.emit('event', { type: 'error', error: String(e) })
      return false
    }
    this.worker = w
    w.on('message', (m: any) => {
      if (this.worker !== w) return
      if (m.type === 'ready') this.ready = true
      if (m.type === 'job') return this.enqueue(m)
      if (m.type === 'mode') this.mode = m.mode
      // load the recognisers only when a command is coming (wake word heard, or a follow-up window is open) —
      // not for every sound the microphone picks up (videos, music, other people)
      if (m.type === 'wake' || (m.type === 'speech' && m.on && this.mode === 'command')) this.ensureChild()
      this.emit('event', m)
    })
    const failed = (error: string) => {
      if (this.worker !== w) return
      const pending = !!this.inFlight || this.queue.length > 0
      this.dispose()
      this.emit('event', { type: 'busy', on: false })
      if (pending) this.emit('event', { type: 'noResult' })
      this.emit('event', { type: 'error', error })
    }
    w.on('error', (e) => failed(String(e)))
    w.on('exit', (code) => failed(`speech worker exited (${code})`))
    try {
      w.postMessage({ type: 'init', vad: p.vad, wakeDir: p.wakeDir, aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    } catch (e) {
      failed(String(e))
      return false
    }
    return true
  }

  // ------------------------------------------------------------------ ASR child
  private childPath() {
    const f = join(__dirname, 'asrChild.js')
    const unpacked = f.replace('app.asar', 'app.asar.unpacked')
    return existsSync(unpacked) ? unpacked : f
  }

  private ensureChild() {
    this.armIdle()
    if (this.child) return
    const p = pathsFor(this.base)
    const s = this.getSettings()
    let c: ChildProcess
    try {
      c = fork(this.childPath(), [], {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        execArgv: [],
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      })
    } catch (e) {
      this.childFailed(null, String(e))
      return
    }
    this.child = c
    this.childReady = false
    c.stderr?.on('data', (d) => {
      if (this.child === c) console.warn('[asr]', String(d).trim().slice(0, 300))
    })
    c.on('message', (m: any) => {
      if (this.child === c) this.onChild(m)
    })
    c.on('error', (e) => this.childFailed(c, String(e)))
    c.on('exit', (code, signal) => this.childFailed(c, `ASR process exited (${signal || code})`))
    this.sendChild(c, {
      type: 'init',
      warm: s.sttLanguage !== 'en',
      cfg: {
        ...englishRecognizer(p, s),
        gigaDir: existsSync(p.gigaDir) ? p.gigaDir : '',
        threads: 4,
        language: s.sttLanguage === 'auto' ? '' : s.sttLanguage
      }
    })
  }

  private sendChild(c: ChildProcess, message: object) {
    try {
      c.send(message, (error: Error | null) => {
        if (error) this.childFailed(c, String(error))
      })
    } catch (e) {
      this.childFailed(c, String(e))
    }
  }

  private childFailed(c: ChildProcess | null, error: string) {
    if (this.child !== c) return
    const pending = !!this.inFlight || this.queue.length > 0
    // Retry a crashed process once. Persistent startup/crash failures must not spawn an endless process loop.
    const retry = ++this.childFailures < 2
    this.killChild(retry)
    if (!retry) this.queue = []
    this.emit('event', { type: 'error', error, soft: true })
    this.emit('event', { type: 'busy', on: false })
    if (pending && !retry) this.emit('event', { type: 'noResult' })
    if (this.worker && this.queue.length) this.ensureChild()
  }

  private armIdle() {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = setTimeout(() => {
      if (this.inFlight || this.queue.length) return this.armIdle()
      this.killChild()
    }, CHILD_IDLE_MS)
  }

  private killChild(retryCurrent = false) {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = null
    const c = this.child
    this.child = null
    this.childReady = false
    // Clear synchronously: the old child's delayed exit must not own the next job's state.
    if (retryCurrent && this.inFlight && !this.produced) this.queue.unshift(this.inFlight)
    this.inFlight = null
    this.produced = false
    try {
      c?.kill()
    } catch {}
  }

  get asrLoaded() {
    return !!this.child
  }

  private enqueue(m: Omit<Job, 'id'>) {
    if (!this.child && !this.inFlight && !this.queue.length) this.childFailures = 0
    this.queue.push({ ...m, id: ++this.seq })
    this.ensureChild()
    this.pump()
  }

  private pump() {
    if (this.inFlight || !this.child || !this.childReady) return
    const job = this.queue.shift()
    if (!job) return
    this.inFlight = job
    this.produced = false
    const s = this.getSettings()
    this.sendChild(this.child, {
      type: 'job',
      id: job.id,
      samples: job.samples,
      commandMode: job.commandMode,
      gateHit: job.gateHit,
      partial: job.partial,
      aliases: this.aliases(),
      sensitivity: s.wakeSensitivity,
      language: s.sttLanguage === 'auto' ? '' : s.sttLanguage
    })
  }

  private onChild(m: any) {
    if (m.type === 'ready') {
      this.childReady = true
      this.pump()
    } else if (m.type === 'event') {
      if (m.id !== 0 && m.id !== this.inFlight?.id) return
      if (m.event.type === 'transcript') {
        this.produced = true
        // A command we were waiting for has been consumed: leave command mode BEFORE the consumer sees the transcript,
        // so it can open a new listening window (wake-only "Джарвис" → "Да, сэр?" → listen) without us cancelling it.
        if (this.inFlight?.commandMode) this.worker?.postMessage({ type: 'mode', mode: 'wake', silent: true })
        // Wake-only ("Джарвис" + pause): the recogniser process may still have been cold-starting, so the user's actual
        // command can already be queued behind this job. It is a command, not room chatter.
        if (this.inFlight && !this.inFlight.commandMode && !String(m.event.text || '').trim()) {
          for (const j of this.queue) j.commandMode = true
        }
      }
      this.emit('event', m.event)
    } else if (m.type === 'done') {
      if (!this.inFlight || m.id !== this.inFlight.id) return
      const wasProduced = this.produced
      this.inFlight = null
      this.produced = false
      this.childFailures = 0
      this.emit('event', { type: 'busy', on: false })
      if (!wasProduced) this.emit('event', { type: 'noResult' })
      this.armIdle()
      this.pump()
    }
  }

  // ------------------------------------------------------------------ controls
  feed(buf: ArrayBuffer) {
    if (!this.worker || !this.ready) return
    const samples = new Float32Array(buf)
    this.worker.postMessage({ type: 'audio', samples }, [samples.buffer])
  }

  listenFor(seconds: number) {
    this.worker?.postMessage({ type: 'mode', mode: 'command', timeoutMs: seconds * 1000 })
  }

  cancelListen() {
    this.worker?.postMessage({ type: 'mode', mode: 'wake' })
  }

  speaking(on: boolean) {
    this.worker?.postMessage({ type: 'speaking', on })
  }

  updateConfig() {
    const s = this.getSettings()
    this.worker?.postMessage({ type: 'config', aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    const pending = !!this.inFlight
    this.killChild(true) // preserve unconsumed audio and decode it with the new configuration
    this.childFailures = 0
    if (pending) this.emit('event', { type: 'busy', on: false })
    if (this.queue.length) this.ensureChild()
  }

  restart() {
    this.dispose()
    return this.start()
  }

  dispose() {
    this.killChild()
    const w = this.worker
    this.worker = null
    this.ready = false
    this.mode = 'wake'
    this.queue = []
    this.inFlight = null
    this.childFailures = 0
    void w?.terminate().catch(() => {})
  }
}

/** which Whisper size to use when Whisper is the chosen (or fallback) English engine */
function whisperKind(s: Settings): 'base' | 'small' | 'turbo' {
  return s.sttModel.startsWith('whisper-') ? (s.sttModel.replace('whisper-', '') as 'base' | 'small' | 'turbo') : 'base'
}

/** Prefer the selected recogniser, then another installed engine rather than a missing base model. */
function englishRecognizer(p: ReturnType<typeof pathsFor>, s: Settings) {
  const chosen = whisperKind(s)
  const kinds = Array.from(new Set([chosen, 'base', 'small', 'turbo'] as const))
  const kind = kinds.find((k) => existsSync(p.whisperDir(k)))
  const parakeet = existsSync(p.parakeetDir)
  const useParakeet = parakeet && (s.sttModel === 'parakeet-en' || !kind)
  return {
    whisperDir: !useParakeet && kind ? p.whisperDir(kind) : '',
    whisperKind: kind || 'base',
    parakeetDir: useParakeet ? p.parakeetDir : ''
  }
}
