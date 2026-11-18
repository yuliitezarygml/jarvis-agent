import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routineEditorReducer as edit, routineEditorRows } from '../src/renderer/src/routine-editor.ts'
import { stepText } from '../src/shared/routine-steps.ts'

test('editing, moving and deleting preserve each step and its displayed draft', () => {
  let rows = routineEditorRows([{ type: 'say', text: 'First' }, { type: 'click', x: 10, y: 20 }, { type: 'open', target: 'Calculator' }])
  const clickId = rows[1].id
  rows = edit(rows, { type: 'text', id: clickId, text: '640,3' })
  rows = edit(rows, { type: 'move', id: clickId, offset: -1 })
  assert.equal(rows[0].id, clickId)
  assert.equal(rows[0].draft ?? stepText(rows[0].step), '640,3')
  assert.deepEqual(rows[0].step, { type: 'click', x: 640, y: 3 })
  const sayId = rows[1].id
  rows = edit(rows, { type: 'remove', id: sayId })
  assert.equal(rows[0].draft ?? stepText(rows[0].step), '640,3')
  assert.equal(rows[1].draft ?? stepText(rows[1].step), 'Calculator')
  assert.deepEqual(rows.map((row) => row.step), [{ type: 'click', x: 640, y: 3 }, { type: 'open', target: 'Calculator' }])
})

test('changing a step type clears the old draft and preserves its pause', () => {
  let rows = routineEditorRows([{ type: 'run', command: 'Write-Host hello', after: 300 }])
  const id = rows[0].id
  rows = edit(rows, { type: 'text', id, text: 'Write-Host edited' })
  rows = edit(rows, { type: 'kind', id, kind: 'wait' })
  assert.equal(rows[0].id, id)
  assert.equal(rows[0].draft, undefined)
  assert.equal(rows[0].draft ?? stepText(rows[0].step), '500')
  assert.deepEqual(rows.map((row) => row.step), [{ type: 'wait', ms: 500, after: 300 }])
})

test('typing text preserves configured character delay and editing a pause preserves the draft', () => {
  let rows = routineEditorRows([{ type: 'type', text: 'before', charDelay: 25 }])
  const id = rows[0].id
  rows = edit(rows, { type: 'text', id, text: '  after  ' })
  rows = edit(rows, { type: 'after', id, after: 120 })
  assert.equal(rows[0].draft, '  after  ')
  assert.deepEqual(rows.map((row) => row.step), [{ type: 'type', text: '  after  ', charDelay: 25, after: 120 }])
})

test('changing a click from coordinates to text does not retain stale coordinates', () => {
  let rows = routineEditorRows([{ type: 'click', x: 100, y: 200, button: 'right', after: 50 }])
  rows = edit(rows, { type: 'text', id: rows[0].id, text: 'Send' })
  assert.deepEqual(rows.map((row) => row.step), [{ type: 'click', text: 'Send', after: 50 }])
})

test('added rows have unique stable IDs and invalid movement leaves the order unchanged', () => {
  let rows = routineEditorRows([{ type: 'say', text: 'hello' }])
  const firstId = rows[0].id
  rows = edit(rows, { type: 'add', step: { type: 'wait', ms: 100 } })
  assert.equal(rows[0].id, firstId)
  assert.notEqual(rows[1].id, firstId)
  assert.equal(edit(rows, { type: 'move', id: firstId, offset: -1 }), rows)
  assert.deepEqual(rows.map((row) => row.step), [{ type: 'say', text: 'hello' }, { type: 'wait', ms: 100 }])
})
