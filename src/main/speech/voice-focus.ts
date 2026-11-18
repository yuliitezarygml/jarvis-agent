import type { VoiceFocusConfig } from '../../shared/voice-focus'

interface Denoiser {
  run(input: { samples: Float32Array; sampleRate: number; enableExternalBuffer: boolean }): { samples: Float32Array }
}

/** Fixed 80 ms batches keep CPU inference below real time without making the VAD block on a file. */
export class VoiceFocusFilter {
  private enabled = false
  private model: Denoiser | null = null
  private pending = new Float32Array(0)

  constructor(private create: (config: VoiceFocusConfig) => Denoiser) {}

  configure(config: VoiceFocusConfig) {
    this.enabled = config.enabled
    this.pending = new Float32Array(0)
    this.model = null
    if (config.enabled) {
      if (!config.enrollModel || !config.chunkModel || !config.voiceSample) throw new Error('Voice focus files are missing')
      this.model = this.create(config)
    }
  }

  process(samples: Float32Array): Float32Array {
    if (!this.enabled) return samples
    if (!this.model) throw new Error('Voice focus is unavailable') // no silent pass-through when enabled
    const input = new Float32Array(this.pending.length + samples.length)
    input.set(this.pending)
    input.set(samples, this.pending.length)
    const chunks: Float32Array[] = []
    let length = 0, offset = 0
    for (; offset + 1280 <= input.length; offset += 1280) {
      const out = this.model.run({ samples: input.subarray(offset, offset + 1280), sampleRate: 16000, enableExternalBuffer: false }).samples
      if (out.length > 4096 || !out.every(Number.isFinite)) {
        this.model = null
        throw new Error('Voice focus returned invalid audio')
      }
      chunks.push(out)
      length += out.length
    }
    this.pending = input.slice(offset)
    const result = new Float32Array(length)
    let at = 0
    for (const chunk of chunks) { result.set(chunk, at); at += chunk.length }
    return result
  }
}

/** The owner explicitly records this local sample. It is never inferred from room speech or TTS. */
export function voiceSampleWav(samples: Float32Array): Buffer {
  if (samples.length < 16000 * 3 || samples.length > 16000 * 12 || !samples.every(Number.isFinite)) throw new Error('Invalid voice sample')
  const wav = Buffer.alloc(44 + samples.length * 2)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return wav
}

export function validVoiceSample(wav: Buffer): boolean {
  return wav.length >= 44 + 16000 * 3 * 2 && wav.length <= 44 + 16000 * 12 * 2 &&
    wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 16) === 'WAVEfmt ' &&
    wav.readUInt32LE(16) === 16 && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1 &&
    wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(34) === 16 &&
    wav.toString('ascii', 36, 40) === 'data' && wav.readUInt32LE(40) === wav.length - 44
}
