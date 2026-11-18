import type { RoutineStep } from '../../shared/types'
import { parseStep } from '../../shared/routine-steps'

export interface RoutineEditorRow {
  id: string
  step: RoutineStep
  /** Keep partially entered coordinates intact until the user finishes typing. */
  draft?: string
}

type RoutineEditorAction =
  | { type: 'text'; id: string; text: string }
  | { type: 'kind'; id: string; kind: RoutineStep['type'] }
  | { type: 'after'; id: string; after?: number }
  | { type: 'move'; id: string; offset: -1 | 1 }
  | { type: 'remove'; id: string }
  | { type: 'add'; step: RoutineStep }

export function routineEditorRows(steps: RoutineStep[]): RoutineEditorRow[] {
  return steps.map((step) => ({ id: crypto.randomUUID(), step }))
}

export function routineEditorReducer(rows: RoutineEditorRow[], action: RoutineEditorAction): RoutineEditorRow[] {
  if (action.type === 'add') return [...rows, ...routineEditorRows([action.step])]
  if (action.type === 'remove') return rows.filter((row) => row.id !== action.id)
  if (action.type === 'move') {
    const from = rows.findIndex((row) => row.id === action.id)
    const to = from + action.offset
    if (from < 0 || to < 0 || to >= rows.length) return rows
    const next = rows.slice()
    ;[next[from], next[to]] = [next[to], next[from]]
    return next
  }
  return rows.map((row) => {
    if (row.id !== action.id) return row
    if (action.type === 'after') return { ...row, step: { ...row.step, after: action.after } }
    if (action.type === 'kind') return { id: row.id, step: parseStep(action.kind, action.kind === 'wait' ? '500' : '', row.step.after) }
    const step = parseStep(row.step.type, action.text, row.step.after)
    // Typing speed is not represented by the one-line input, so preserve it.
    if (step.type === 'type' && row.step.type === 'type') step.charDelay = row.step.charDelay
    return { ...row, step, draft: action.text }
  })
}
