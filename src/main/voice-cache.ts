import { DEFAULT_SETTINGS, type Settings } from '../shared/types'

/** Keep cached acknowledgements separate when switching voice servers or speed. */
export function voiceCacheKey(settings: Settings, voice: string, line: string): string {
  const source = settings.voiceMode === 'server'
    ? ['server', (settings.ttsServerUrl.trim() || DEFAULT_SETTINGS.ttsServerUrl).replace(/\/+$/, '')]
    : ['custom', settings.fishModel, voice === 'fish:en' ? settings.fishVoiceEn : settings.fishVoiceRu]
  return `${voice}|${JSON.stringify([...source, settings.voiceSpeed, line])}`
}
