// Hidden "audio host" page: microphone capture → main (speech engine), and TTS playback with the Jarvis polish chain.
import { api, IPC } from './api'
import type { Settings } from '@shared/types'
import { PlaybackController, prepareAudioPlayback } from './audio-playback'

let settings: Settings | null = null
let micCtx: AudioContext | null = null
let micStream: MediaStream | null = null
let currentMic = ''
let micGeneration = 0
let micRetry: ReturnType<typeof setTimeout> | null = null
let disconnectMic: (() => void) | null = null
let micStatus: { state: 'starting' | 'ready' | 'error'; deviceId: string; error?: string } = { state: 'starting', deviceId: 'default' }

function reportMicStatus(status: typeof micStatus) {
  micStatus = status
  api.send(IPC.micStatus, status)
}

function releaseMic(stream: MediaStream | null, ctx: AudioContext | null) {
  stream?.getTracks().forEach((track) => track.stop())
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {})
}

function retryMic(generation: number) {
  if (micRetry !== null) clearTimeout(micRetry)
  micRetry = setTimeout(() => {
    micRetry = null
    if (generation === micGeneration) void startMic()
  }, 4000)
}

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(800); this.n = 0 }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        let s = 0
        for (let j = 0; j < this.n; j++) s += this.buf[j] * this.buf[j]
        this.port.postMessage({ pcm: this.buf.slice(0), rms: Math.sqrt(s / this.n) })
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('capture', Capture)
`

async function startMic() {
  stopMic()
  const generation = micGeneration
  const id = settings?.micDeviceId ?? 'default'
  currentMic = id
  reportMicStatus({ state: 'starting', deviceId: id })
  let stream: MediaStream | null = null
  let ctx: AudioContext | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: id === 'default' ? undefined : { exact: id },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    if (generation !== micGeneration) {
      releaseMic(stream, ctx)
      return
    }
    micStream = stream
    const tracks = stream.getTracks()
    const onTrackEnded = () => {
      if (generation !== micGeneration) return
      stopMic()
      reportMicStatus({ state: 'error', deviceId: id, error: 'Microphone disconnected or stopped' })
      retryMic(micGeneration)
    }
    const removeTrackListeners = () => tracks.forEach((track) => track.removeEventListener('ended', onTrackEnded))
    tracks.forEach((track) => track.addEventListener('ended', onTrackEnded))
    disconnectMic = removeTrackListeners
    if (tracks.some((track) => track.readyState === 'ended')) throw new Error('Microphone disconnected or stopped')
    ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    micCtx = ctx
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    if (generation !== micGeneration) {
      releaseMic(stream, ctx)
      return
    }
    const src = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'capture')
    node.port.onmessage = (e) => {
      if (generation !== micGeneration) return
      const { pcm, rms } = e.data as { pcm: Float32Array; rms: number }
      api.send(IPC.audioChunk, pcm.buffer)
      api.send(IPC.micLevel, Math.min(1, rms * 7))
    }
    src.connect(node)
    // keep the graph alive without audible output
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(ctx.destination)
    disconnectMic = () => {
      removeTrackListeners()
      node.port.onmessage = null
      src.disconnect()
      node.disconnect()
      mute.disconnect()
    }
    reportMicStatus({ state: 'ready', deviceId: id })
  } catch (e) {
    releaseMic(stream, ctx)
    if (generation !== micGeneration) return
    disconnectMic?.()
    disconnectMic = null
    micStream = null
    micCtx = null
    console.error('mic failed', e)
    reportMicStatus({ state: 'error', deviceId: id, error: e instanceof Error ? e.message : String(e) })
    retryMic(generation)
  }
}

function stopMic() {
  micGeneration++
  if (micRetry !== null) clearTimeout(micRetry)
  micRetry = null
  disconnectMic?.()
  disconnectMic = null
  releaseMic(micStream, micCtx)
  micStream = null
  micCtx = null
}

// ------------------------------------------------------------------ playback
let outCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let levelTimer: number | null = null

function ensureOut() {
  if (!outCtx) {
    outCtx = new AudioContext()
    analyser = outCtx.createAnalyser()
    analyser.fftSize = 512
    analyser.connect(outCtx.destination)
  }
  return outCtx
}

function jarvisChain(ctx: AudioContext, fx: boolean, volume: number): { input: AudioNode; dispose: () => void } {
  const gain = ctx.createGain()
  const nodes: AudioNode[] = [gain]
  const dispose = () => nodes.forEach((node) => node.disconnect())
  gain.gain.value = volume
  gain.connect(analyser!)
  if (!fx) return { input: gain, dispose }
  // gentle "digital butler" polish: presence lift, air, short metallic comb, soft limiter
  const hp = ctx.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.value = 80
  const presence = ctx.createBiquadFilter()
  presence.type = 'peaking'
  presence.frequency.value = 2400
  presence.Q.value = 0.9
  presence.gain.value = 3.5
  const air = ctx.createBiquadFilter()
  air.type = 'highshelf'
  air.frequency.value = 7000
  air.gain.value = 2.5
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = -18
  comp.ratio.value = 3
  const delay = ctx.createDelay(0.05)
  delay.delayTime.value = 0.011
  const fb = ctx.createGain()
  fb.gain.value = 0.22
  const wet = ctx.createGain()
  wet.gain.value = 0.28
  nodes.push(hp, presence, air, comp, delay, fb, wet)
  hp.connect(presence).connect(air).connect(comp)
  comp.connect(gain)
  comp.connect(delay)
  delay.connect(fb).connect(delay)
  delay.connect(wet).connect(gain)
  return { input: hp, dispose }
}

function startLevels() {
  if (levelTimer) return
  const data = new Uint8Array(analyser!.fftSize)
  levelTimer = window.setInterval(() => {
    analyser!.getByteTimeDomainData(data)
    let s = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      s += v * v
    }
    api.send(IPC.ttsLevel, Math.min(1, Math.sqrt(s / data.length) * 4.5))
  }, 33)
}
function stopLevels() {
  if (levelTimer) clearInterval(levelTimer)
  levelTimer = null
  api.send(IPC.ttsLevel, 0)
}

const playback = new PlaybackController<{ id: string; wav: Uint8Array; fx: boolean; volume: number }>({
  prepare: (req, signal) => {
    const ctx = ensureOut()
    return prepareAudioPlayback(ctx, req.wav, signal, (src) => {
      const chain = jarvisChain(ctx, req.fx, req.volume)
      src.connect(chain.input)
      return chain.dispose
    })
  },
  started: () => startLevels(),
  ended: (req) => {
    stopLevels()
    api.send(IPC.ttsEnded, req.id)
  },
  failed: (e) => console.error('playback failed', e)
})

function earcon(kind = 'wake') {
  if (settings && !settings.wakeSound) return
  const ctx = ensureOut()
  const t = ctx.currentTime
  const o = ctx.createOscillator()
  const g = ctx.createGain()
  o.type = 'sine'
  const [f0, f1] = kind === 'sleep' ? [900, 420] : [620, 1240]
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.11)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
  o.connect(g).connect(ctx.destination)
  o.start(t)
  o.stop(t + 0.22)
}

async function main() {
  settings = await api.invoke(IPC.settingsGet)
  api.on(IPC.settingsChanged, (s: Settings) => {
    const changed = s.micDeviceId !== currentMic
    settings = s
    if (changed) void startMic()
  })
  api.on(IPC.ttsPlay, (req: any) => void playback.play(req))
  api.on(IPC.ttsStop, () => playback.stop())
  api.on(IPC.micStatusRequest, () => api.send(IPC.micStatus, micStatus))
  api.on('audio:earcon', (k: string) => earcon(k))
  await startMic()
}

void main()
