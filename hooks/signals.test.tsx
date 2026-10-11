import { expect, test } from 'claude-code/testing'

import { NO_STEPS, exploredTokens, hasHandoffCommand, isCorrection, isExplorationHeavy, openSteps, planEventOf, stepsAfter } from './signals'

const todo = (status: string) => ({ content: 'x', status, activeForm: 'x' })

test('a todo list counts its pending and in-progress items, and a newer list replaces it', () => {
  const two = stepsAfter(NO_STEPS, 'TodoWrite', {}, { oldTodos: [], newTodos: [todo('pending'), todo('in_progress'), todo('completed')] })
  expect(openSteps(two)).toBe(2)
  const done = stepsAfter(two, 'TodoWrite', {}, { oldTodos: [], newTodos: [todo('completed'), todo('completed')] })
  expect(openSteps(done)).toBe(0)
  expect(openSteps(stepsAfter(NO_STEPS, 'TodoWrite', { todos: [todo('pending')] }, undefined))).toBe(1)
})

test('tasks are tracked by id: created pending, moved by updates, dropped when deleted', () => {
  let steps = stepsAfter(NO_STEPS, 'TaskCreate', { subject: 'a', description: 'a' }, { task: { id: '1', subject: 'a' } })
  steps = stepsAfter(steps, 'TaskCreate', { subject: 'b', description: 'b' }, { task: { id: '2', subject: 'b' } })
  expect(openSteps(steps)).toBe(2)
  steps = stepsAfter(steps, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true })
  expect(openSteps(steps)).toBe(1)
  steps = stepsAfter(steps, 'TaskUpdate', { taskId: '2', status: 'deleted' }, { success: true })
  expect(openSteps(steps)).toBe(0)
  expect(stepsAfter(steps, 'TaskUpdate', { taskId: '3', subject: 'renamed' }, { success: true })).toBe(steps)
})

test('todos and tasks add up, and other tools change nothing', () => {
  const both = stepsAfter(stepsAfter(NO_STEPS, 'TodoWrite', {}, { newTodos: [todo('pending')] }), 'TaskCreate', {}, { task: { id: '9', subject: 's' } })
  expect(openSteps(both)).toBe(2)
  expect(stepsAfter(both, 'Read', { file_path: '/x' }, {})).toBe(both)
})

test('a plan is saved by ExitPlanMode or by writing a spec or plan file; other edits mean work started', () => {
  expect(planEventOf('ExitPlanMode', {}, { plan: 'p', isAgent: false, filePath: '/Users/x/.claude/plans/calm-fox.md' })).toEqual({ kind: 'saved', path: '/Users/x/.claude/plans/calm-fox.md' })
  expect(planEventOf('ExitPlanMode', {}, { plan: 'p', isAgent: false })).toBeUndefined()
  expect(planEventOf('Write', { file_path: '/r/docs/superpowers/specs/2026-10-11-x-design.md' }, {})).toEqual({ kind: 'saved', path: '/r/docs/superpowers/specs/2026-10-11-x-design.md' })
  expect(planEventOf('Edit', { file_path: '/r/docs/plans/x.md' }, {})).toEqual({ kind: 'saved', path: '/r/docs/plans/x.md' })
  expect(planEventOf('Write', { file_path: '/r/SPEC.md' }, {})).toEqual({ kind: 'saved', path: '/r/SPEC.md' })
  expect(planEventOf('Write', { file_path: 'PLAN.md' }, {})).toEqual({ kind: 'saved', path: 'PLAN.md' })
  expect(planEventOf('Edit', { file_path: '/r/hooks/strategy.ts' }, {})).toEqual({ kind: 'work' })
  expect(planEventOf('Edit', { file_path: '/r/docs/plans/deep/x.md' }, {})).toEqual({ kind: 'work' })
  expect(planEventOf('Write', { file_path: '/r/specs/x.txt' }, {})).toEqual({ kind: 'work' })
  expect(planEventOf('NotebookEdit', { notebook_path: '/r/a.ipynb' }, {})).toEqual({ kind: 'work' })
  expect(planEventOf('Read', { file_path: '/r/SPEC.md' }, {})).toBeUndefined()
})

test('correcting prompts are recognised; ordinary follow-ups are not', () => {
  for (const hit of [
    'no, use the other file',
    'Nope.',
    'still failing',
    'It still doesn’t compile',
    "that's wrong",
    'this is not what I asked for',
    "it didn't work",
    'does not work after the change',
    'same error as before',
    'Wrong file',
  ]) expect(isCorrection(hit)).toBe(true)
  expect(isCorrection('no')).toBe(true)
  for (const miss of ['no need to add tests', 'no worries, do the next one', 'no problem, now the docs', 'now add tests', 'nothing else, thanks', 'note the edge case', 'looks good, commit it', '/clear', '', 'nobody uses that flag, drop it']) {
    expect(isCorrection(miss)).toBe(false)
  }
})

test('exploration counts the text of read and search results, not images', () => {
  expect(exploredTokens('Read', { type: 'text', file: { filePath: '', content: 'x'.repeat(4000), numLines: 1, startLine: 1, totalLines: 1 } })).toBe(1001)
  expect(exploredTokens('Glob', { filenames: ['a'.repeat(200), 'b'.repeat(200)], durationMs: 1, numFiles: 2, truncated: false })).toBe(100)
  expect(exploredTokens('Read', { type: 'image', file: { base64: 'x'.repeat(100_000), type: 'image/png', originalSize: 1 } })).toBeLessThan(10)
  expect(exploredTokens('Bash', { stdout: 'x'.repeat(4000) })).toBe(0)
})

test('exploration is heavy at 30k tokens that are also 30% of the context', () => {
  expect(isExplorationHeavy(40_000, 100_000)).toBe(true)
  expect(isExplorationHeavy(29_000, 50_000)).toBe(false)
  expect(isExplorationHeavy(40_000, 200_000)).toBe(false)
  expect(isExplorationHeavy(40_000, 0)).toBe(false)
})

test('a handoff command is found by name, plugin-scoped or not', () => {
  expect(hasHandoffCommand(['route', 'handoff'])).toBe(true)
  expect(hasHandoffCommand(['superpowers:handoff'])).toBe(true)
  expect(hasHandoffCommand(['handoffs', 'route'])).toBe(false)
})
