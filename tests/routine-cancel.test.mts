import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { RoutineCancellation, RoutineCancelledError, RoutineRunner } from '../src/main/routine-cancel.ts'

// Load the real coordinators with an inert Electron module and a fake child-process factory.
// Tests never construct an Assistant, start a process, or send input to the desktop.
const require = createRequire(import.meta.url)
const electronPath = require.resolve('electron')
const previousElectron = require.cache[electronPath]
require.cache[electronPath] = { exports: { app: {} } } as NodeModule
const childProcess = require('node:child_process')
const originalSpawn = childProcess.spawn
let spawnProcess: (...args: any[]) => any = () => { throw new Error('unexpected process spawn') }
childProcess.spawn = (...args: any[]) => spawnProcess(...args)
const { Assistant } = require('../src/main/assistant.ts') as typeof import('../src/main/assistant.ts')
const { Opencode } = require('../src/main/opencode.ts') as typeof import('../src/main/opencode.ts')
test.after(() => {
  childProcess.spawn = originalSpawn
  if (previousElectron) require.cache[electronPath] = previousElectron
  else delete require.cache[electronPath]
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function assistant(call: (cmd: string, args: any) => Promise<any> = async () => ({})) {
  const value: any = new EventEmitter()
  Object.setPrototypeOf(value, Assistant.prototype)
  const opencode: any = new EventEmitter()
  opencode.isBusy = false
  opencode.aborts = 0
  opencode.abort = async () => { opencode.aborts++; opencode.isBusy = false; opencode.emit('turnEnd') }
  Object.assign(value, {
    routineRunner: new RoutineRunner(), agentAbort: null, opencode,
    win: { call }, mcp: { computer: { cancel() {} } },
    grantedThreads: new Set(), stopSpeaking() {}, setControl() {}, setState() {}
  })
  return value as InstanceType<typeof Assistant>
}

const routine = (steps: any[]) => ({ id: 'test', name: 'test', phrases: [], steps, createdAt: 0, updatedAt: 0 })

test('emergency stop interrupts a long wait and prevents the next key action', { timeout: 2000 }, async () => {
  const actions: string[] = []
  const subject = assistant(async (cmd) => { actions.push(cmd) })
  const running = subject.runRoutine(routine([{ type: 'wait', ms: 60000 }, { type: 'keys', keys: 'enter' }]))
  await nextTurn()
  subject.emergencyStop()
  assert.match(await running, /Routine cancelled/)
  assert.deepEqual(actions, [])
})

test('abortTask interrupts the pause after a completed step', { timeout: 2000 }, async () => {
  const actions: string[] = []
  const subject = assistant(async (_cmd, args) => { actions.push(args.keys) })
  const running = subject.runRoutine(routine([
    { type: 'keys', keys: 'first', after: 60000 }, { type: 'keys', keys: 'second' }
  ]))
  await nextTurn()
  await subject.abortTask()
  assert.match(await running, /Routine cancelled/)
  assert.deepEqual(actions, ['first'])
})

test('a cancelled in-flight key-down is followed by key-up and no later steps', { timeout: 2000 }, async () => {
  const down = deferred()
  const entered = deferred()
  const actions: string[] = []
  const subject = assistant(async (cmd) => {
    actions.push(cmd)
    if (cmd === 'keydown') { entered.resolve(); await down.promise }
  })
  const running = subject.runRoutine(routine([{ type: 'hold', keys: 'w', ms: 20000 }, { type: 'keys', keys: 'enter' }]))
  await entered.promise
  subject.emergencyStop()
  down.resolve()
  assert.match(await running, /Routine cancelled/)
  assert.deepEqual(actions, ['keydown', 'keyup'])
})

test('cancelling an asynchronous screen lookup prevents its eventual click', { timeout: 2000 }, async () => {
  const scan = deferred<any>()
  const entered = deferred()
  const actions: string[] = []
  const subject: any = assistant(async (cmd) => { actions.push(cmd) })
  subject.mcp.computer.scan = () => { entered.resolve(); return scan.promise }
  subject.mcp.computer.find = () => [{ score: 1, rect: { x: 0, y: 0, w: 10, h: 10 } }]
  const running = subject.runRoutine(routine([{ type: 'click', text: 'Send' }, { type: 'keys', keys: 'enter' }]))
  await entered.promise
  subject.emergencyStop()
  scan.resolve({})
  assert.match(await running, /Routine cancelled/)
  assert.deepEqual(actions, [])
})

test('a replacement routine waits for the previous held key to be released', { timeout: 2000 }, async () => {
  const released = deferred()
  const releasing = deferred()
  const holding = deferred()
  const actions: string[] = []
  const subject = assistant(async (cmd) => {
    actions.push(cmd)
    if (cmd === 'keydown') holding.resolve()
    if (cmd === 'keyup') { releasing.resolve(); await released.promise }
  })
  const first = subject.runRoutine(routine([{ type: 'hold', keys: 'w', ms: 20000 }]))
  await holding.promise
  const second = subject.runRoutine(routine([{ type: 'keys', keys: 'enter' }]))
  await releasing.promise
  assert.deepEqual(actions, ['keydown', 'keyup'])
  released.resolve()
  assert.match(await first, /Routine cancelled/)
  assert.equal(await second, 'keys')
  assert.deepEqual(actions, ['keydown', 'keyup', 'keys'])
})

test('a real action error remains visible and diagnostics omit its private message', async () => {
  const actions: string[] = []
  const subject = assistant(async (_cmd, args) => {
    actions.push(args.keys)
    if (args.keys === 'first') throw new Error('private command payload')
  })
  const diagnostics: unknown[] = []
  subject.on('diagnosticError', (event) => diagnostics.push(event))
  const result = await subject.runRoutine(routine([{ type: 'keys', keys: 'first' }, { type: 'keys', keys: 'second' }]))
  assert.match(result, /step keys failed/)
  assert.deepEqual(actions, ['first', 'second'])
  assert.deepEqual(diagnostics, [{ source: 'routine', message: 'Routine step failed (keys)' }])
})

test('cancelling a routine kills its active PowerShell child', { timeout: 2000 }, async () => {
  const spawned = deferred()
  let killed = 0
  spawnProcess = () => {
    const process: any = new EventEmitter()
    process.stdout = new EventEmitter()
    process.stderr = new EventEmitter()
    process.kill = () => { killed++; queueMicrotask(() => process.emit('close')); return true }
    spawned.resolve()
    return process
  }
  const actions: string[] = []
  const subject = assistant(async (cmd) => { actions.push(cmd) })
  const running = subject.runRoutine(routine([{ type: 'run', command: 'fake command' }, { type: 'keys', keys: 'enter' }]))
  await spawned.promise
  subject.emergencyStop()
  assert.match(await running, /Routine cancelled/)
  assert.equal(killed, 1)
  assert.deepEqual(actions, [])
})

test('an already cancelled PowerShell request does not spawn a process', async () => {
  const run = new RoutineCancellation()
  run.cancel()
  spawnProcess = () => assert.fail('cancelled request spawned a process')
  await assert.rejects(assistant().powershell('fake command', 60000, run.signal), RoutineCancelledError)
})

test('an agent step that finishes without an agent turn does not hang', { timeout: 2000 }, async () => {
  const actions: string[] = []
  const subject: any = assistant(async (cmd) => { actions.push(cmd) })
  subject.handleCommand = async () => {}
  assert.equal(await subject.runRoutine(routine([{ type: 'agent', prompt: 'fake fast command' }, { type: 'keys', keys: 'enter' }])), 'agent task done\nkeys')
  assert.deepEqual(actions, ['keys'])
})

test('cancellation while the agent wakes prevents a late prompt POST', { timeout: 2000 }, async () => {
  const waking = deferred()
  let posts = 0
  const agent: any = new Opencode(() => ({ model: 'test/model' }) as any, { mcpUrl: '', mcpToken: '' }, {} as any)
  agent.wake = () => waking.promise
  agent.req = async () => { posts++ }
  const run = new RoutineCancellation()
  const sending = agent.send('private prompt', '', 'text', run.signal)
  run.cancel()
  waking.resolve()
  await assert.rejects(sending, RoutineCancelledError)
  assert.equal(posts, 0)
})
