import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'
import { voiceCacheKey } from '../src/main/voice-cache.ts'

test('switching between shared server, own server and direct Fish cannot reuse the previous voice', () => {
  const settings = { ...DEFAULT_SETTINGS, voiceMode: 'server' as const, ttsServerUrl: 'http://192.168.50.38:8080' }
  const key = voiceCacheKey(settings, 'fish:ru', 'Да, сэр?')
  assert.notEqual(key, voiceCacheKey(DEFAULT_SETTINGS, 'fish:ru', 'Да, сэр?'))
  assert.notEqual(key, voiceCacheKey({ ...settings, voiceMode: 'custom' }, 'fish:ru', 'Да, сэр?'))
  assert.equal(key, voiceCacheKey({ ...settings, ttsServerUrl: settings.ttsServerUrl + '/' }, 'fish:ru', 'Да, сэр?'))
  assert.notEqual(key, voiceCacheKey({ ...settings, voiceSpeed: 1.2 }, 'fish:ru', 'Да, сэр?'))
})

test('direct voice changes invalidate cached speech and secrets are not cache identifiers', () => {
  const settings = { ...DEFAULT_SETTINGS, voiceMode: 'custom' as const, fishApiKey: 'private-test-value' }
  const key = voiceCacheKey(settings, 'fish:ru', 'Да, сэр?')
  assert.notEqual(key, voiceCacheKey({ ...settings, fishVoiceRu: 'another-voice' }, 'fish:ru', 'Да, сэр?'))
  assert.notEqual(key, voiceCacheKey({ ...settings, fishModel: 'another-model' }, 'fish:ru', 'Да, сэр?'))
  assert.equal(key.includes(settings.fishApiKey), false)
})
