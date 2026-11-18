import test from 'node:test'
import assert from 'node:assert/strict'
import { Diagnostics, diagnosticMessage, diagnosticServerUrl, probeTtsServer, synthesisDiagnosticError } from '../src/main/diagnostics.ts'

const current = { speech: { state: 'ready' as const, asrLoaded: false, missingModels: [] }, voiceMode: 'server' as const, voiceEnabled: true }

test('TTS health reports the configured server, voice, languages and response time', async () => {
  const result = await probeTtsServer('http://192.168.50.38:8080/', async (url, init) => {
    assert.equal(url, 'http://192.168.50.38:8080/api/health')
    assert.ok(init?.signal)
    return Response.json({ ok: true, model: 'Pocket TTS', voice: 'Jarvis RU', languages: ['ru'], external_tts: false })
  })
  assert.equal(result.ok, true)
  assert.equal(result.voice, 'Jarvis RU')
  assert.deepEqual(result.languages, ['ru'])
  assert.ok(result.ms >= 0)
  assert.ok(result.checkedAt > 0)
})

test('TTS health handles HTTP, malformed response and connection failures', async () => {
  const http = await probeTtsServer('http://server:8080', async () => new Response('secret response', { status: 503 }))
  assert.equal(http.ok, false)
  assert.equal(http.error, 'HTTP 503')
  const malformed = await probeTtsServer('http://server:8080', async () => Response.json({ status: 'running' }))
  assert.equal(malformed.ok, false)
  assert.match(malformed.error!, /not ready/)
  const offline = await probeTtsServer('http://server:8080', async () => { throw new Error('Connection refused') })
  assert.equal(offline.error, 'Connection refused')
})

test('diagnostics remove credentials and request text instead of retaining them', () => {
  const message = diagnosticMessage(new Error('Bearer abc123 failed for private spoken sentence at https://user:pass@example.com?token=xyz'), ['private spoken sentence'])
  for (const secret of ['abc123', 'private spoken sentence', 'user:pass', 'xyz']) assert.equal(message.includes(secret), false)
  assert.equal(diagnosticServerUrl('http://user:password@server:8080/path?key=secret'), 'http://server:8080/path')
})

test('synthesis errors never retain upstream excerpts of a spoken request', () => {
  assert.equal(synthesisDiagnosticError(new Error('bad input: a private fragment')), 'Speech synthesis failed')
  assert.equal(synthesisDiagnosticError(Object.assign(new Error('quoted private fragment'), { status: 503 })), 'TTS HTTP 503')
  assert.equal(synthesisDiagnosticError(new Error('free voice server unreachable (fetch failed)')), 'Could not connect to the TTS server')
})

test('invalid or credential-bearing server URLs are not requested', async () => {
  let calls = 0
  for (const url of ['invalid', 'file:///tmp/test', 'http://user:password@server', 'http://server?key=secret']) {
    const result = await probeTtsServer(url, async () => { calls++; return Response.json({ ok: true }) })
    assert.equal(result.ok, false)
  }
  assert.equal(calls, 0)
})

test('microphone recovery updates current state and preserves the last error with its time', () => {
  const diagnostics = new Diagnostics()
  diagnostics.recordMicrophone({ state: 'error', deviceId: 'default', error: 'Permission denied' })
  diagnostics.recordMicrophone({ state: 'ready', deviceId: 'default' })
  const snapshot = diagnostics.snapshot(current)
  assert.equal(snapshot.microphone.state, 'ready')
  assert.equal(snapshot.microphone.error, undefined)
  assert.equal(snapshot.lastError?.source, 'microphone')
  assert.equal(snapshot.lastError?.message, 'Permission denied')
  assert.ok(snapshot.lastError!.at > 0)
})

test('refreshing an unchanged microphone error preserves when it actually occurred', async () => {
  const diagnostics = new Diagnostics()
  const error = { state: 'error' as const, deviceId: 'default', error: 'Device disconnected' }
  diagnostics.recordMicrophone(error)
  const before = diagnostics.snapshot(current)
  await new Promise((resolve) => setTimeout(resolve, 5))
  diagnostics.recordMicrophone(error)
  const after = diagnostics.snapshot(current)
  assert.equal(after.microphone.at, before.microphone.at)
  assert.equal(after.lastError?.at, before.lastError?.at)
})

test('synthesis diagnostics survive recovery and returned snapshots cannot mutate stored state', () => {
  const diagnostics = new Diagnostics()
  diagnostics.recordSynthesis({ voice: 'fish:ru', ok: false, at: 1, ms: 200, error: 'Server unavailable' })
  diagnostics.recordSynthesis({ voice: 'fish:ru', ok: true, at: 2, ms: 75 })
  const snapshot = diagnostics.snapshot(current)
  assert.equal(snapshot.synthesis?.ms, 75)
  assert.equal(snapshot.synthesis?.ok, true)
  assert.equal(snapshot.lastError?.message, 'Server unavailable')
  snapshot.microphone.deviceId = 'changed'
  assert.equal(diagnostics.snapshot(current).microphone.deviceId, '')
})
