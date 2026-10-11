import { expect, test } from 'claude-code/testing'

import { handoffPath, handoffWindow, shouldAutoHandoff, tildePath } from './handoff'
import type { HandoffFacts } from './handoff'

const due: HandoffFacts = { isOn: true, isArmed: true, isIdle: true, isPromptEmpty: true, warmMinutes: 2, ttlMinutes: 60, tokens: 140_000, openSteps: 3, hasPlan: false }

test('auto-handoff fires in the last minutes of a warm cache with work open', () => {
  expect(shouldAutoHandoff(due)).toBe(true)
  expect(shouldAutoHandoff({ ...due, openSteps: 0, hasPlan: true })).toBe(true)
  expect(shouldAutoHandoff({ ...due, warmMinutes: 3 })).toBe(true)
})

test('each condition alone holds it back', () => {
  for (const over of [
    { isOn: false },
    { isArmed: false },
    { isIdle: false },
    { isPromptEmpty: false },
    { warmMinutes: 0 },
    { warmMinutes: 4 },
    { tokens: 49_000 },
    { openSteps: 1 },
  ] satisfies Partial<HandoffFacts>[]) {
    expect(shouldAutoHandoff({ ...due, ...over })).toBe(false)
  }
})

test('a 5-minute cache gets a narrower window the minute tick still sees', () => {
  expect(handoffWindow(60)).toBe(3)
  expect(handoffWindow(5)).toBe(2)
  expect(shouldAutoHandoff({ ...due, ttlMinutes: 5, warmMinutes: 3 })).toBe(false)
  expect(shouldAutoHandoff({ ...due, ttlMinutes: 5, warmMinutes: 2 })).toBe(true)
})

test('handoff files go under ~/.claude/handoffs/<repo>/ with a local timestamp and short session id', () => {
  const at = new Date(2026, 9, 11, 14, 32).getTime()
  expect(handoffPath('/Users/x', 'claude-model-router', at, 'ab12cd34-ffff-0000')).toBe('/Users/x/.claude/handoffs/claude-model-router/2026-10-11-1432-ab12cd34.md')
  expect(handoffPath('/Users/x/', 'my repo/../evil', at, '../../etc')).toBe('/Users/x/.claude/handoffs/my-repo-..-evil/2026-10-11-1432---..-etc.md')
  expect(handoffPath('/Users/x', '..', at, 's')).toBe('/Users/x/.claude/handoffs/-/2026-10-11-1432-s.md')
})

test('a sanitised segment never climbs out of the handoffs folder', () => {
  const path = handoffPath('/h', '../..', 0, '../x')
  expect(path.startsWith('/h/.claude/handoffs/')).toBe(true)
  const parts = path.slice('/h/.claude/handoffs/'.length).split('/')
  expect(parts).toHaveLength(2)
  expect(parts[0]!.startsWith('.')).toBe(false)
})

test('paths under home are shown with a tilde', () => {
  expect(tildePath('/Users/x/.claude/handoffs/r/a.md', '/Users/x')).toBe('~/.claude/handoffs/r/a.md')
  expect(tildePath('/tmp/a.md', '/Users/x')).toBe('/tmp/a.md')
  expect(tildePath('/Users/xy/a.md', '/Users/x')).toBe('/Users/xy/a.md')
  expect(tildePath('/Users/x/a.md', undefined)).toBe('/Users/x/a.md')
})
