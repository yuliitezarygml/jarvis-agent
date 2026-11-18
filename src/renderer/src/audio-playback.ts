/** A prepared sound owns its source and the effect nodes connected to it. */
export interface PreparedPlayback {
  start: () => void
  stop: () => void
  dispose: () => void
  onEnded: (callback: () => void) => void
}

/** Decode cannot be aborted by Web Audio, so check cancellation after each await. */
export async function prepareAudioPlayback(
  ctx: AudioContext,
  wav: Uint8Array,
  signal: AbortSignal,
  connect: (source: AudioBufferSourceNode) => () => void
): Promise<PreparedPlayback | null> {
  if (ctx.state === 'suspended') await ctx.resume()
  if (signal.aborted) return null
  const bytes = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
  const buffer = await ctx.decodeAudioData(bytes)
  if (signal.aborted) return null
  const source = ctx.createBufferSource()
  source.buffer = buffer
  let disposeEffects: () => void
  try {
    disposeEffects = connect(source)
  } catch (error) {
    source.disconnect()
    throw error
  }
  return {
    start: () => source.start(),
    stop: () => source.stop(),
    onEnded: (callback) => { source.onended = callback },
    dispose: () => {
      source.onended = null
      source.disconnect()
      disposeEffects()
    }
  }
}

interface PlaybackDriver<Request> {
  prepare: (request: Request, signal: AbortSignal) => Promise<PreparedPlayback | null>
  started: (request: Request) => void
  ended: (request: Request) => void
  failed: (error: unknown, request: Request) => void
}

interface PlaybackSession<Request> {
  request: Request
  controller: AbortController
  sound: PreparedPlayback | null
  done: boolean
}

/** Owns pending preparation as well as the sound already playing. */
export class PlaybackController<Request> {
  private active: PlaybackSession<Request> | null = null

  constructor(private readonly driver: PlaybackDriver<Request>) {}

  async play(request: Request): Promise<void> {
    this.stop()
    const session: PlaybackSession<Request> = { request, controller: new AbortController(), sound: null, done: false }
    this.active = session
    try {
      const sound = await this.driver.prepare(request, session.controller.signal)
      if (session.done) {
        sound?.dispose()
        return
      }
      session.sound = sound
      if (!sound) {
        this.finish(session)
        return
      }
      sound.onEnded(() => this.finish(session))
      this.driver.started(request)
      sound.start()
    } catch (error) {
      if (!session.done) this.driver.failed(error, request)
      this.finish(session)
    }
  }

  stop(): void {
    const session = this.active
    if (!session) return
    session.controller.abort()
    try {
      session.sound?.stop()
    } catch {}
    this.finish(session)
  }

  private finish(session: PlaybackSession<Request>): void {
    if (session.done) return
    session.done = true
    session.controller.abort()
    if (this.active === session) this.active = null
    try {
      session.sound?.dispose()
    } finally {
      this.driver.ended(session.request)
    }
  }
}
