export interface VoiceFocusStatus {
  enabled: boolean
  profile: boolean
  state: 'off' | 'loading' | 'ready' | 'error' | 'recording'
  seconds: number
  error?: 'models' | 'profile' | 'filter' | 'quiet' | 'microphone' | 'save'
}

export interface VoiceFocusConfig {
  enabled: boolean
  enrollModel: string
  chunkModel: string
  voiceSample: string
}

export const VOICE_SAMPLE_SECONDS = 10
