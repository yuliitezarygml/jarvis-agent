import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { JarvisMcp } from '../src/main/mcp.ts'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'

test('MCP rejects interrupted tools and a late prepared voice line, then admits a new task', { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-mcp-test-'))
  const said: string[] = []
  const win = { call: async () => ({}) }
  const hub = { tmpDir: root, win, scanWin: win, settings: () => ({ ...DEFAULT_SETTINGS }), say: async (text: string) => { said.push(text) } }
  const mcp = new JarvisMcp(hub as any)
  await mcp.start()
  const client = new Client({ name: 'interruption-test', version: '1' })
  t.after(async () => {
    await client.close()
    mcp.stop()
    assert.ok(root.startsWith(join(tmpdir(), 'jarvis-mcp-test-')))
    rmSync(root, { recursive: true, force: true })
  })
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: { authorization: `Bearer ${mcp.token}` } } }))
  mcp.pause()
  const blocked = await client.callTool({ name: 'say', arguments: { text: 'must not be spoken' } })
  assert.equal(blocked.isError, true)
  assert.equal(said.length, 0)
  mcp.newTask()
  await client.callTool({ name: 'say', arguments: { text: 'new task' } })
  assert.deepEqual(said, ['new task'])

  let release!: (value: unknown[]) => void
  let started!: () => void
  const preparing = new Promise<void>((resolve) => { started = resolve })
  ;(mcp as any).resolveTargets = () => { started(); return new Promise((resolve) => { release = resolve }) }
  const late = client.callTool({ name: 'say', arguments: { text: 'old prepared line', highlight: [{ text: 'example' }] } })
  await preparing
  mcp.pause()
  release([])
  const lateResult = await late
  assert.equal(lateResult.isError, true)
  assert.deepEqual(said, ['new task'])
})
