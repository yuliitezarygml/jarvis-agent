/** Audio endpoints are recognition chunks, not permission to execute a command. */
export interface CommandTranscript {
  text: string
  raw: string
  lang: string
  viaWake: boolean
  woke: boolean
  ms: number
}

interface Clock {
  now(): number
  after(ms: number, run: () => void): () => void
}

const clock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  }
}

const words = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
const STOP = /^(стоп|отмена|отмени|отмени команду|хватит|замолчи|stop|cancel|cancel command|abort|enough|never mind)$/
const THINK = /^(подожди|погоди|дай подумать|сейчас подумаю|секунду|wait|one moment|let me think)$/
// Deliberately explicit standalone phrases; "готово" can be part of dictated text.
const FINISH = /^(все выполняй|команда закончена|я закончил команду|end command|execute command)$/

/** Conservative local hints, not a claim to understand every unfinished thought. */
export function needsContinuation(text: string): boolean {
  const t = words(text).replace(/\s+пожалуйста$/, '').replace(/^please\s+/, '')
  if (!t || THINK.test(t)) return true
  if (/(?:^|\s)(и|или|но|чтобы|потому что|в|во|на|из|с|со|к|ко|от|до|по|про|о|об|для|через|между|нет|точнее|and|or|but|to|from|with|about|into|for|the|a|an|of)$/.test(t)) return true
  if (/^(найди|поищи)(?:\s+(в интернете|в сети|информацию))?$/.test(t)) return true
  return /^(открой|найди|покажи|запусти|включи|выключи|создай|удали|перенеси|перемести|скопируй|напиши|отправь|сохрани|расскажи|объясни|нет|точнее|ну|эм|open|find|show|launch|start|create|delete|move|copy|write|send|save|explain|no|actually)$/.test(t)
}

export class CommandBuffer {
  private transcript: CommandTranscript | null = null
  private startedAt = 0
  private quietAt = 0
  private hearing = false
  private jobs = 0
  private holding = false
  private finishRequested = false
  private revision = 0
  private stopTimer: (() => void) | undefined
  private stopLimit: (() => void) | undefined

  constructor(private options: {
    pauseMs: () => number
    answerMode?: () => boolean
    complete: (transcript: CommandTranscript) => void
    draft: (text: string, waiting: boolean) => void
    expired: (reason: 'incomplete' | 'limit') => void
    clock?: Clock
  }) {}

  private get time() { return this.options.clock ?? clock }
  get active() { return this.transcript !== null }
  get text() { return this.transcript?.text ?? '' }

  speech(on: boolean) {
    this.hearing = on
    if (!on) this.quietAt = this.time.now()
    if (this.active) {
      this.options.draft(this.text, !on)
      this.arm()
    }
  }

  pending(count: number) {
    this.jobs = count
    this.arm()
  }

  accept(part: CommandTranscript) {
    const text = part.text.trim()
    if (!text) return
    const t = words(text)
    const dictating = /^(напиши|запиши|диктуй|write|type|dictate)(?:\s|$)/i.test(this.text)
    if (STOP.test(t) && (!dictating || /^(отмени команду|cancel command)$/.test(t))) {
      this.cancel()
      this.options.complete(part)
      return
    }
    if (!this.transcript) {
      this.transcript = { ...part, text: '' }
      this.startedAt = this.time.now()
      this.stopLimit = this.time.after(120_000, () => this.expire('limit'))
    }
    if (FINISH.test(t) && this.text && !dictating) {
      this.finishRequested = true
      this.holding = false
    } else if (THINK.test(t) && !dictating) {
      this.holding = true
    } else {
      // Preserve corrections ("нет, документы") for the command parser / agent.
      // Never remove repeated words heuristically: a user may be dictating them.
      const previous = this.transcript
      this.transcript = {
        ...previous,
        text: [previous.text, text].filter(Boolean).join(' '),
        raw: [previous.text ? previous.raw : '', part.raw].filter(Boolean).join(' '),
        lang: previous.text ? previous.lang : part.lang,
        ms: previous.text ? previous.ms + part.ms : part.ms
      }
      this.holding = false
      this.finishRequested = false
    }
    if (this.text.length > 8000) return this.expire('limit')
    this.options.draft(this.text, !this.hearing)
    this.arm()
  }

  cancel() {
    this.revision++
    this.stopTimer?.()
    this.stopLimit?.()
    this.stopTimer = this.stopLimit = undefined
    this.transcript = null
    this.holding = this.finishRequested = false
    this.hearing = false
    this.jobs = 0
  }

  private arm() {
    this.stopTimer?.()
    this.stopTimer = undefined
    const revision = ++this.revision
    if (!this.transcript || this.hearing || this.jobs) return
    const shortAnswer = this.options.answerMode?.() && /^(да|нет|yes|no)$/.test(words(this.text))
    const incomplete = this.holding || (!shortAnswer && needsContinuation(this.text))
    const configured = this.options.pauseMs()
    const pause = Number.isFinite(configured) ? Math.min(10_000, Math.max(1000, configured)) : 3500
    const delay = this.finishRequested && !incomplete ? 0 : incomplete ? 20_000 : pause
    const due = Math.max(this.startedAt, this.quietAt) + delay
    this.stopTimer = this.time.after(Math.max(0, due - this.time.now()), () => {
      if (revision !== this.revision || this.hearing || this.jobs || !this.transcript) return
      if (incomplete) return this.expire('incomplete')
      const result = this.transcript
      this.cancel()
      this.options.complete(result)
    })
  }

  private expire(reason: 'incomplete' | 'limit') {
    this.cancel()
    this.options.expired(reason)
  }
}
