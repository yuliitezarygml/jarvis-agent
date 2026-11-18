import { findWake, normalize } from './textmatch'

export type ConversationControl = { action: 'start'; topic: string } | { action: 'end' }

/** Match whole requests, including a trailing name, without swallowing the words before it. */
export function conversationControl(text: string, aliases: string[], sensitivity = 0.6): ConversationControl | null {
  if (/[«»“”"]/.test(text)) return null
  const raw = text.trim().replace(/^(эй|привет|hey|hello)[,\s]+/i, '')
  const tokens = raw.split(/\s+/)
  const candidates = [raw]
  const first = findWake(raw, aliases, sensitivity, 1)
  if (first) candidates.unshift(tokens.slice(first.consumed).join(' '))
  for (let i = Math.max(1, tokens.length - 4); i < tokens.length; i++) {
    const last = findWake(tokens.slice(i).join(' '), aliases, sensitivity, 1)
    if (last?.consumed === tokens.length - i) candidates.unshift(tokens.slice(0, i).join(' '))
  }
  for (const candidate of candidates) {
    const clean = candidate.replace(/^[,.:;!?\s]+|[,.:;!?\s]+$/g, '')
    const start = clean.match(/^(?:давай(?:те)?\s+(?:пообщаемся|поговорим|поболтаем)|(?:включи|начни)\s+режим\s+(?:разговора|общения)|let['’]?s\s+(?:talk|chat)|start\s+(?:a\s+)?conversation)(?:\s+(?:про|о|об|about)\s+([\s\S]+))?$/i)
    if (start) return { action: 'start', topic: start[1]?.trim() ?? '' }
    if (/^(закончим разговор|закончи разговор|заверши разговор|хватит общаться|вернись в режим ожидания|end (?:the )?conversation|stop chatting|go back to standby)$/.test(normalize(clean))) return { action: 'end' }
  }
  return null
}

export const conversationPause = (text: string) => /^(подожди|погоди|секунду|дай подумать|сейчас подумаю|wait|one moment|let me think)$/.test(normalize(text))

/** A second line of defence after acoustic echo cancellation; one-word user replies stay available. */
export class SpeechEchoFilter {
  private recent: { words: string[]; until: number }[] = []
  remember(text: string, now = Date.now()) {
    this.recent = this.recent.filter((x) => x.until >= now).slice(-8)
    this.recent.push({ words: normalize(text).split(' ').filter(Boolean), until: now + 60_000 })
  }
  ended(now = Date.now()) {
    for (const item of this.recent) item.until = Math.min(item.until, now + 3000)
  }
  matches(text: string, now = Date.now()) {
    const input = normalize(text).split(' ').filter(Boolean)
    if (input.length < 2) return false
    return this.recent.some((item) => {
      if (input.length < 4) {
        const same = input.every((word, i) => item.words[i] === word)
        const acknowledgement = /^(я слушаю|да сэр|слушаю сэр|хорошо сэр|к вашим услугам|i m listening|yes sir|at your service)$/.test(input.join(' '))
        return item.until >= now && same && (input.length === item.words.length || acknowledgement)
      }
      if (item.until < now || input.length < item.words.length * 0.6) return false
      let next = 0
      let hits = 0
      for (const word of input) {
        const index = item.words.indexOf(word, next)
        if (index >= 0) { next = index + 1; hits++ }
      }
      return hits / input.length >= 0.9
    })
  }
}
