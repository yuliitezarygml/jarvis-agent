import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('native Chromium UIA scan retries once and preserves filtered/unfiltered results', { skip: process.platform !== 'win32' }, (t) => {
  // Compile the production methods against an in-memory accessibility tree: no Windows UIA or desktop calls are made.
  const source = readFileSync(new URL('../native/JarvisNative/Uia.cs', import.meta.url), 'utf8')
  const start = source.indexOf('        public static Dictionary<string, object> FlatScan(')
  const end = source.indexOf('        public static Dictionary<string, object> FlatInvoke(', start)
  assert.ok(start >= 0 && end > start, 'FlatScan methods must be available to the behavioral harness')
  const harness = readFileSync(new URL('./fixtures/native-uia-harness.cs', import.meta.url), 'utf8')
    .replace('// FLAT_SCAN_METHODS', source.slice(start, end))
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-uia-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'UiaHarness.cs'), harness)
  writeFileSync(join(directory, 'run.ps1'), "$ErrorActionPreference = 'Stop'\nAdd-Type -Path (Join-Path $PSScriptRoot 'UiaHarness.cs')\n[UiaHarness]::Run()\n")
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'run.ps1')], {
    encoding: 'utf8', windowsHide: true, timeout: 30_000
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /14 UIA retry cases passed/)
})
