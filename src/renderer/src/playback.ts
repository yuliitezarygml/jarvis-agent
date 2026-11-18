export interface AudioRequest { id: string; wav: Uint8Array; fx: boolean; volume: number }

/** Stop invalidates pending decoding as well as audio that is already audible. */
export class AudioPlayback {
  private epoch = 0
  private current: { src: AudioBufferSourceNode; id: string } | null = null

  constructor(private host: {
    context(): AudioContext
    chain(ctx: AudioContext, fx: boolean, volume: number): { input: AudioNode }
    startLevels(): void
    stopLevels(): void
    ended(id: string, completed: boolean): void
  }) {}

  stop() {
    this.epoch++
    const previous = this.current
    this.current = null
    try { previous?.src.stop() } catch {}
    this.host.stopLevels()
  }

  async play(req: AudioRequest) {
    this.stop()
    const epoch = this.epoch
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      if (this.current?.id === req.id) {
        this.current = null
        this.host.stopLevels()
      }
      this.host.ended(req.id, completed)
    }
    try {
      const ctx = this.host.context()
      if (ctx.state === 'suspended') await ctx.resume()
      if (epoch !== this.epoch) return finish(false)
      const ab = req.wav.buffer.slice(req.wav.byteOffset, req.wav.byteOffset + req.wav.byteLength) as ArrayBuffer
      const buf = await ctx.decodeAudioData(ab)
      if (epoch !== this.epoch) return finish(false)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.host.chain(ctx, req.fx, req.volume).input)
      this.current = { src, id: req.id }
      src.onended = () => finish(epoch === this.epoch)
      this.host.startLevels()
      src.start()
    } catch (e) {
      console.error('playback failed', e)
      finish(false)
    }
  }
}
