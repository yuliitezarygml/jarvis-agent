import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isLegacyPiperConfig } from '../src/shared/piper-config.ts'
import { CATALOG, listAssets } from '../src/main/models.ts'

test('Piper compatibility checks Unicode codepoints, not UTF-16 length or version labels alone', () => {
  assert.equal(isLegacyPiperConfig({ phoneme_type: 'espeak', phoneme_id_map: { a: [1], '𐀀': [2] } }), true)
  assert.equal(isLegacyPiperConfig({ phoneme_type: 'espeak', phoneme_id_map: { 'aɪ': [161] } }), false)
  assert.equal(isLegacyPiperConfig({ phoneme_type: 'espeak', phoneme_id_map: {} }), false)
  assert.equal(isLegacyPiperConfig({ phoneme_type: 'espeak', phoneme_id_map: { a: [-1] } }), false)
  assert.equal(isLegacyPiperConfig(null), false)
})

test('an existing voice is reinstalled when its config is missing, corrupt or incompatible', () => {
  const prefix = join(tmpdir(), 'jarvis-model-assets-')
  const root = mkdtempSync(prefix)
  const dir = join(root, 'models/tts/voices')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ru_RU-denis-medium.onnx'), 'model fixture')
    const installed = () => listAssets(root).find((a) => a.id === 'ru_RU-denis-medium')!.installed
    assert.equal(installed(), false)
    const config = join(dir, 'ru_RU-denis-medium.onnx.json')
    writeFileSync(config, '{')
    assert.equal(installed(), false)
    writeFileSync(config, JSON.stringify({ phoneme_type: 'espeak', phoneme_id_map: { 'aɪ': [161] } }))
    assert.equal(installed(), false)
    writeFileSync(config, JSON.stringify({ phoneme_type: 'espeak', phoneme_id_map: { a: [1] } }))
    assert.equal(installed(), true)
    const files = CATALOG.find((a) => a.id === 'ru_RU-denis-medium')!.files!
    assert.ok(files.every((file) => file.url.includes('/a60bfb1358818a92675b3a2d9d48fb8ea47035c1/')))
  } finally {
    assert.ok(root.startsWith(prefix))
    rmSync(root, { recursive: true, force: true })
  }
})

test('Russian build cannot reinstall the removed Romanian voice or require English models', () => {
  assert.equal(CATALOG.some((asset) => asset.id.startsWith('ro_')), false)
  assert.equal(CATALOG.find((asset) => asset.id === 'parakeet-en')?.required, false)
  assert.equal(CATALOG.find((asset) => asset.id === 'jarvis-high')?.required, false)
  assert.equal(CATALOG.find((asset) => asset.id === 'gigaam-ru')?.required, true)
})

test('voice isolation is unavailable until both pinned model files pass checksum verification', () => {
  const prefix = join(tmpdir(), 'jarvis-focus-assets-')
  const root = mkdtempSync(prefix)
  const dir = join(root, 'models/voice-focus')
  try {
    mkdirSync(dir, { recursive: true })
    const installed = () => listAssets(root).find((a) => a.id === 'voxlock')!.installed
    assert.equal(installed(), false)
    writeFileSync(join(dir, 'voxlock_enroll.onnx'), 'incomplete model')
    assert.equal(installed(), false)
    writeFileSync(join(dir, 'voxlock_chunk_int8.onnx'), 'incorrect model')
    assert.equal(installed(), false)
  } finally {
    assert.ok(root.startsWith(prefix))
    rmSync(root, { recursive: true, force: true })
  }
})
