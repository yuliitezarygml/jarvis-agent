import type { DiagnosticsSnapshot, MicrophoneStatus, SynthesisDiagnostic, TtsServerDiagnostic } from '../shared/types'

/** Keep diagnostic messages useful without retaining request text or credentials. */
export function diagnosticMessage(error: unknown, sensitive: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(value).join('[redacted]')
  return message
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:api[_-]?key|key|token|password|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]+/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300)
}

export function diagnosticServerUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/** Upstream errors can quote fragments of the speech text: retain only a known category/status. */
export function synthesisDiagnosticError(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) return `TTS HTTP ${status}`
  const message = error instanceof Error ? error.message : ''
  if (/timeout|timed out/i.test(message)) return 'Speech synthesis timed out'
  if (/unreachable|fetch failed|ECONNREFUSED|ENETUNREACH/i.test(message)) return 'Could not connect to the TTS server'
  if (/not set|not installed|ENOENT/i.test(message)) return 'Voice engine or voice is not configured'
  if (/unexpected data|returned no audio/i.test(message)) return 'TTS returned invalid audio'
  if (/piper exited/i.test(message)) return 'Piper process stopped'
  return 'Speech synthesis failed'
}

export async function probeTtsServer(value: string, request: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<TtsServerDiagnostic> {
  const started = performance.now()
  const result: TtsServerDiagnostic = { url: diagnosticServerUrl(value), ok: false, checkedAt: Date.now(), ms: 0 }
  try {
    const url = new URL(value.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid TTS server URL')
    const response = await request(url.href.replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    if (!body || typeof body !== 'object' || body.ok !== true) throw new Error('TTS server is not ready')
    result.ok = true
    for (const key of ['engine', 'model', 'voice', 'notice'] as const) {
      if (typeof body[key] === 'string') result[key] = diagnosticMessage(body[key])
    }
    if (Array.isArray(body.languages)) result.languages = body.languages.filter((item: unknown) => typeof item === 'string').slice(0, 20)
  } catch (error) {
    result.error = diagnosticMessage(error)
  }
  result.ms = Math.round(performance.now() - started)
  return result
}

export class Diagnostics {
  private microphone: MicrophoneStatus = { state: 'unknown', deviceId: '', at: Date.now() }
  private server: TtsServerDiagnostic | null = null
  private synthesis: SynthesisDiagnostic | null = null
  private lastError: DiagnosticsSnapshot['lastError'] = null
  private changed: () => void

  constructor(changed: () => void = () => {}) {
    this.changed = changed
  }

  recordMicrophone(status: Omit<MicrophoneStatus, 'at'>) {
    const error = status.error ? diagnosticMessage(status.error) : undefined
    if (this.microphone.state === status.state && this.microphone.deviceId === status.deviceId && this.microphone.error === error) return
    this.microphone = { ...status, error, at: Date.now() }
    if (status.state === 'error') this.recordError('microphone', this.microphone.error || 'Microphone unavailable', false)
    this.changed()
  }

  recordServer(server: TtsServerDiagnostic) {
    this.server = structuredClone(server)
    if (!server.ok) this.recordError('tts', server.error || 'TTS server unavailable', false)
    this.changed()
  }

  recordSynthesis(result: SynthesisDiagnostic) {
    this.synthesis = { ...result, error: result.error ? diagnosticMessage(result.error) : undefined }
    if (!result.ok) this.recordError('tts', this.synthesis.error || 'Speech synthesis failed', false)
    this.changed()
  }

  recordError(source: NonNullable<DiagnosticsSnapshot['lastError']>['source'], error: unknown, notify = true) {
    this.lastError = { source, message: diagnosticMessage(error), at: Date.now() }
    if (notify) this.changed()
  }

  snapshot(current: Pick<DiagnosticsSnapshot, 'speech' | 'voiceMode' | 'voiceEnabled'>): DiagnosticsSnapshot {
    return structuredClone({ microphone: this.microphone, server: this.server, synthesis: this.synthesis, lastError: this.lastError, ...current })
  }
}
