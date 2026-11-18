import { Worker } from 'worker_threads'
import { fork, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { join } from 'path'
import { existsSync } from 'fs'
import type { Settings } from '../../shared/types'
import { pathsFor } from '../models'
import { CommandBuffer } from './command-buffer'
import { conversationControl, conversationPause, SpeechEchoFilter } from '../../shared/conversation'

export type SpeechEvent =
  | { type: 'ready' }
  | { type: 'error'; error: string; soft?: boolean }
  | { type: 'speech'; on: boolean }
  | { type: 'partial'; text: string }
  | { type: 'wake'; text: string }
  | { type: 'wakeRejected'; text: string }
  | { type: 'busy'; on: boolean }
  | { type: 'noResult' }
  | { type: 'draft'; text: string; waiting: boolean }
  | { type: 'inputExpired'; reason: 'incomplete' | 'limit' | 'recognition' }
  | { type: 'conversation'; on: boolean; reason?: 'user' | 'idle' | 'cancelled' }
  | { type: 'conversationPause' }
  | { type: 'mode'; mode: 'wake' | 'command'; timedOut?: boolean }
  | { type: 'transcript'; text: string; raw: string; woke: boolean; ms: number; viaWake: boolean; lang: string }

interface Job {
  id: number
  capturedAt: number
  generation: number
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
  private seq = 0
  private generation = 0
  private collectCommands = true
  private answerMode = false
  private readonly buffer: CommandBuffer
  private conversationActive = false
  private conversationTimer: NodeJS.Timeout | null = null
  private inputSpeaking = false
  private outputSpeaking = false
  private responding = false
  private readonly echo = new SpeechEchoFilter()
  ready = false

  constructor(
    private base: string,
    private getSettings: () => Settings
  ) {
    super()
    this.buffer = new CommandBuffer({
      pauseMs: () => this.getSettings().commandPauseSeconds * 1000,
      answerMode: () => this.answerMode,
      complete: (transcript) => {
        this.cancelListen(false)
        this.emit('event', { type: 'transcript', ...transcript })
      },
      draft: (text, waiting) => this.emit('event', { type: 'draft', text, waiting }),
      expired: (reason) => {
        this.cancelListen(false)
        this.emit('event', { type: 'inputExpired', reason })
      }
    })
  }

  get commandDraft() { return this.buffer.active }
  get conversation() { return this.conversationActive }

  setConversation(on: boolean, reason: 'user' | 'idle' | 'cancelled' = 'user') {
    const changed = this.conversationActive !== on
    this.conversationActive = on
    if (this.conversationTimer) clearTimeout(this.conversationTimer)
    this.conversationTimer = null
    if (on) {
      this.setMode('command')
      this.armConversation()
    } else this.cancelListen(false)
    if (changed) this.emit('event', { type: 'conversation', on, reason })
  }

  setResponding(on: boolean) {
    this.responding = on
    this.armConversation()
  }

  private armConversation() {
    if (this.conversationTimer) clearTimeout(this.conversationTimer)
    this.conversationTimer = null
    if (!this.conversationActive) return
    const configured = this.getSettings().conversationIdleSeconds
    const seconds = Number.isFinite(configured) ? Math.max(30, Math.min(600, configured)) : 120
    this.conversationTimer = setTimeout(() => {
      if (this.inputSpeaking || this.outputSpeaking || this.responding || this.buffer.active || this.pendingJobs()) this.armConversation()
      else this.setConversation(false, 'idle')
    }, seconds * 1000)
  }

  missing(): string[] {
    const p = pathsFor(this.base)
    const s = this.getSettings()
    const miss: string[] = []
    if (!existsSync(p.vad)) miss.push('silero-vad')
    if (!p.wakeDir) miss.push('wake-ru-zipformer')
    const haveWhisper = existsSync(p.whisperDir(whisperKind(s))) || existsSync(p.whisperDir('base'))
    if (s.sttLanguage === 'auto' || s.sttLanguage === 'ro') {
      if (!haveWhisper) miss.push('whisper-base')
    } else if (s.sttLanguage === 'ru') {
      if (!existsSync(p.gigaDir) && !haveWhisper) miss.push('gigaam-ru')
    } else if (!existsSync(p.parakeetDir) && !haveWhisper) miss.push('parakeet-en')
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
    const w = new Worker(join(__dirname, 'speechWorker.js'))
    this.worker = w
    w.on('message', (m: any) => {
      if (this.worker !== w) return
      this.onWorker(m)
    })
    w.on('error', (e) => {
      if (this.worker !== w) return
      this.cancelListen()
      this.emit('event', { type: 'error', error: String(e) })
    })
    w.on('exit', () => {
      if (this.worker !== w) return
      this.cancelListen()
      this.worker = null
      this.ready = false
    })
    w.postMessage({ type: 'init', generation: this.generation, vad: p.vad, wakeDir: p.wakeDir, aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    return true
  }

  private onWorker(m: any) {
    if (m.type === 'ready') this.ready = true
    if (m.type !== 'ready' && m.generation !== this.generation) return
    if (m.type === 'job') return this.enqueue(m)
    if (m.type === 'speech') {
      this.inputSpeaking = m.on
      this.buffer.speech(m.on)
    }
    // A listening-window timeout must not discard a draft or a chunk still being decoded.
    if (m.type === 'mode' && m.timedOut && (this.conversationActive || this.buffer.active || this.pendingJobs())) {
      this.setMode('command')
      return
    }
    if (m.type === 'mode') this.mode = m.mode
    // Background speech never preloads the heavy recogniser; an active command does.
    if (m.type === 'wake' || (m.type === 'speech' && m.on && this.mode === 'command')) this.ensureChild()
    this.emit('event', m)
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
    const c = fork(this.childPath(), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    this.child = c
    this.childReady = false
    c.stderr?.on('data', (d) => console.warn('[asr]', String(d).trim().slice(0, 300)))
    c.on('message', (m: any) => { if (this.child === c) this.onChild(m) })
    c.on('exit', () => {
      if (this.child === c) {
        this.child = null
        this.childReady = false
        if (this.inFlight) {
          // died mid-job: tell the UI so it never sits on "transcribing"
          this.cancelListen()
          this.inFlight = null
          this.emit('event', { type: 'busy', on: false })
          this.emit('event', { type: 'noResult' })
          this.emit('event', { type: 'inputExpired', reason: 'recognition' })
        }
        if (this.queue.length) this.ensureChild()
      }
    })
    c.send({
      type: 'init',
      warm: s.sttLanguage !== 'en' && s.sttLanguage !== 'ro',
      cfg: {
        whisperDir: existsSync(p.whisperDir(whisperKind(s))) ? p.whisperDir(whisperKind(s)) : p.whisperDir('base'),
        whisperKind: existsSync(p.whisperDir(whisperKind(s))) ? whisperKind(s) : 'base',
        parakeetDir: s.sttModel === 'parakeet-en' && existsSync(p.parakeetDir) ? p.parakeetDir : '',
        gigaDir: existsSync(p.gigaDir) ? p.gigaDir : '',
        threads: 4,
        language: s.sttLanguage === 'auto' ? '' : s.sttLanguage
      }
    })
  }

  private armIdle() {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = setTimeout(() => {
      if (this.inFlight || this.queue.length) return this.armIdle()
      this.killChild()
    }, CHILD_IDLE_MS)
  }

  private killChild() {
    if (this.childIdle) clearTimeout(this.childIdle)
    this.childIdle = null
    const c = this.child
    this.child = null
    this.childReady = false
    try {
      c?.kill()
    } catch {}
  }

  get asrLoaded() {
    return !!this.child
  }

  private enqueue(m: Omit<Job, 'id' | 'capturedAt'>) {
    if (this.queue.length >= 12) {
      this.cancelListen()
      this.emit('event', { type: 'inputExpired', reason: 'limit' })
      return
    }
    this.queue.push({ ...m, id: ++this.seq, capturedAt: Date.now() })
    this.buffer.pending(this.pendingJobs())
    this.ensureChild()
    this.pump()
  }

  private pendingJobs() {
    return this.queue.filter((j) => j.generation === this.generation).length + Number(this.inFlight?.generation === this.generation)
  }

  private pump() {
    if (this.inFlight || !this.child || !this.childReady) return
    const job = this.queue.shift()
    if (!job) return
    this.inFlight = job
    this.produced = false
    const s = this.getSettings()
    this.child.send({
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
      if (m.id === 0) { this.emit('event', m.event); return }
      if (m.id !== this.inFlight?.id || this.inFlight?.generation !== this.generation) return
      if (m.event.type === 'transcript') {
        if (this.produced) return // one final transcript per recognition job
        this.produced = true
        const control = conversationControl(m.event.raw, this.aliases(), this.getSettings().wakeSensitivity)
        if (control) m.event = { ...m.event, text: m.event.raw }
        if (this.conversationActive && this.collectCommands && this.echo.matches(m.event.text, this.inFlight.capturedAt)) return
        if (this.conversationActive) this.armConversation()
        if (this.conversationActive && !this.buffer.active && conversationPause(m.event.text)) {
          this.emit('event', { type: 'conversationPause' })
          return
        }
        // Verification of the first wake phrase also authorises already captured continuation chunks.
        if (!this.inFlight.commandMode) {
          for (const j of this.queue) j.commandMode = true
        }
        if (this.collectCommands && String(m.event.text || '').trim()) {
          this.setMode('command') // stay open across VAD endpoints until the whole command is ready
          this.buffer.accept(m.event)
          return
        }
        if (this.buffer.active) return
        this.setMode(this.conversationActive ? 'command' : 'wake')
      }
      this.emit('event', m.event)
    } else if (m.type === 'done') {
      if (!this.inFlight || m.id !== this.inFlight.id) return
      const current = this.inFlight.generation === this.generation
      const wasProduced = this.produced
      this.inFlight = null
      this.buffer.pending(this.pendingJobs())
      if (current) {
        this.emit('event', { type: 'busy', on: false })
        if (!wasProduced && this.buffer.active) {
          // A lost continuation must not turn the earlier partial command into an executable one.
          this.cancelListen()
          this.emit('event', { type: 'inputExpired', reason: 'recognition' })
        } else if (!wasProduced) this.emit('event', { type: 'noResult' })
      }
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

  private setMode(mode: 'wake' | 'command', timeoutMs = 0) {
    this.mode = mode
    this.worker?.postMessage({ type: 'mode', mode, timeoutMs })
  }

  listenFor(seconds: number, collect = true, answerMode = false) {
    this.collectCommands = collect
    this.answerMode = answerMode
    this.setMode('command', this.buffer.active || this.conversationActive ? 0 : seconds * 1000)
  }

  cancelListen(endConversation = true) {
    if (endConversation && this.conversationActive) {
      this.conversationActive = false
      if (this.conversationTimer) clearTimeout(this.conversationTimer)
      this.conversationTimer = null
      this.emit('event', { type: 'conversation', on: false, reason: 'cancelled' })
    }
    this.generation++
    this.queue = []
    this.inputSpeaking = false
    this.collectCommands = true
    this.answerMode = false
    this.buffer.cancel()
    this.mode = this.conversationActive ? 'command' : 'wake'
    this.worker?.postMessage({ type: 'reset', generation: this.generation, mode: this.mode })
    this.emit('event', { type: 'draft', text: '', waiting: false })
    this.emit('event', { type: 'mode', mode: this.mode })
    this.emit('event', { type: 'busy', on: false })
    this.armConversation()
  }

  speaking(on: boolean, text = '') {
    this.outputSpeaking = on
    if (on && text) this.echo.remember(text)
    if (!on) this.echo.ended()
    this.armConversation()
    this.worker?.postMessage({ type: 'speaking', on })
  }

  updateConfig() {
    this.cancelListen()
    const s = this.getSettings()
    this.worker?.postMessage({ type: 'config', aliases: this.aliases(), wakeEnabled: s.wakeEnabled })
    this.killChild() // language / model choice changed: the next utterance starts a fresh child with the new settings
    this.inFlight = null
  }

  restart() {
    this.dispose()
    return this.start()
  }

  dispose() {
    this.cancelListen()
    this.killChild()
    void this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.queue = []
    this.inFlight = null
  }
}

/** which Whisper size to use when Whisper is the chosen (or fallback) English engine */
function whisperKind(s: Settings): 'base' | 'small' | 'turbo' {
  return s.sttModel.startsWith('whisper-') ? (s.sttModel.replace('whisper-', '') as 'base' | 'small' | 'turbo') : 'base'
}
