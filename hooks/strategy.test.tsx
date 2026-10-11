import { expect, test } from 'claude-code/testing'

import { MODELS, money, rewritePrice } from './routes'
import { adviseSession, boundaryOf } from './strategy'
import type { StrategyFacts } from './strategy'

const opus = MODELS.opus.id

const facts = (over: Partial<StrategyFacts> = {}): StrategyFacts => ({
  tokens: 100_000,
  window: 1_000_000,
  compactAt: 800_000,
  model: opus,
  ttlMinutes: 60,
  warmMinutes: 40,
  ...over,
})

test('a small or comfortable context carries on', () => {
  expect(adviseSession(facts({ tokens: 10_000, boundary: 'commit', warmMinutes: 0 }))).toMatchObject({ verdict: 'continue', reason: 'small' })
  expect(adviseSession(facts())).toMatchObject({ verdict: 'continue', reason: 'fine' })
})

test('a commit or PR over a sizeable context says clear, priced per request', () => {
  const advice = adviseSession(facts({ tokens: 200_000, boundary: 'commit' }))
  const warm = rewritePrice(opus, 200_000, 60).warm
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'boundary', perRequestUsd: warm })
  expect(advice.text).toBe('Work was committed. Each further request re-reads the 200k tokens of finished work ($0.04 warm): /clear and start the next task fresh, or /compact to carry a summary.')
  expect(adviseSession(facts({ tokens: 200_000, boundary: 'pr' })).text).toMatch(/^A pull request went up\./)
  expect(adviseSession(facts({ tokens: 30_000, boundary: 'commit' })).verdict).toBe('continue')
})

test('a cold cache over a big context says clear, since compacting pays the rewrite too', () => {
  const advice = adviseSession(facts({ tokens: 200_000, warmMinutes: 0 }))
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'cold' })
  expect(advice.text).toBe('The cache went cold: the next send, /compact included, re-writes 200k tokens for $1.60. /clear is free.')
})

test('nearing auto-compact says compact, at a point you choose', () => {
  const advice = adviseSession(facts({ tokens: 700_000 }))
  expect(advice).toMatchObject({ verdict: 'compact', reason: 'near-compact' })
  expect(advice.text).toBe('100k tokens to auto-compact: /compact now and say what to keep (the plan, open TODOs, touched files), rather than let it fire mid-task.')
  expect(adviseSession(facts({ tokens: 870_000, compactAt: undefined })).reason).toBe('near-compact')
})

test('a conversation filling a well-used context says compact', () => {
  expect(adviseSession(facts({ tokens: 500_000, messagesShare: 0.7 }))).toMatchObject({ verdict: 'compact', reason: 'conversation' })
  expect(adviseSession(facts({ tokens: 500_000, messagesShare: 0.4 })).verdict).toBe('continue')
  expect(adviseSession(facts({ tokens: 300_000, messagesShare: 0.9 })).verdict).toBe('continue')
})

test('rules apply in order: a boundary beats a cold cache, a cold cache beats nearing compact', () => {
  expect(adviseSession(facts({ tokens: 700_000, warmMinutes: 0, boundary: 'commit' })).reason).toBe('boundary')
  expect(adviseSession(facts({ tokens: 700_000, warmMinutes: 0 })).reason).toBe('cold')
})

test('a model without prices still gets a verdict, without dollars', () => {
  const advice = adviseSession(facts({ tokens: 200_000, boundary: 'commit', model: 'some-other-model' }))
  expect(advice.verdict).toBe('clear')
  expect(advice.text).not.toMatch(/\$/)
})

test('commits and pull requests are boundaries; other git commands are not', () => {
  expect(boundaryOf('git commit -m "Fix it"')).toBe('commit')
  expect(boundaryOf('git add -A && git -c user.name=x commit -m wip')).toBe('commit')
  expect(boundaryOf('gh pr create --fill')).toBe('pr')
  expect(boundaryOf('gh pr merge 12 --squash')).toBe('pr')
  expect(boundaryOf('git commit --dry-run')).toBeUndefined()
  expect(boundaryOf('git status')).toBeUndefined()
  expect(boundaryOf('gh pr view 12')).toBeUndefined()
  expect(boundaryOf('echo "run git commit later"')).toBeUndefined()
  expect(boundaryOf("echo 'gh pr create'")).toBeUndefined()
  expect(boundaryOf('git commit-tree HEAD^{tree}')).toBeUndefined()
  expect(boundaryOf('git commit -m "fix \\"quoted\\" bug" && git push')).toBe('commit')
})

const SKILL_STEP = 'write a handoff with /handoff, /clear, then resume from it'
const ASK_STEP = 'ask Claude to save the plan, progress and next steps to a file, /clear, then point the new session at it'

test('a commit with steps still open says handoff, naming the skill only when it is installed', () => {
  const advice = adviseSession(facts({ tokens: 120_000, boundary: 'commit', openSteps: 4 }))
  expect(advice).toMatchObject({ verdict: 'handoff', reason: 'boundary', command: 'handoff' })
  const warm = money(rewritePrice(opus, 120_000, 60).warm)
  expect(advice.text).toBe(`Work was committed with 4 steps still open. Each request re-reads 120k tokens (${warm} warm): ${ASK_STEP}. A /compact summary keeps less of the plan.`)
  const withSkill = adviseSession(facts({ tokens: 120_000, boundary: 'pr', openSteps: 4, hasHandoffSkill: true }))
  expect(withSkill).toMatchObject({ verdict: 'handoff', command: '/handoff' })
  expect(withSkill.text).toMatch(/^A pull request went up with 4 steps still open\./)
  expect(withSkill.text).toContain(SKILL_STEP)
  expect(adviseSession(facts({ tokens: 120_000, boundary: 'commit', openSteps: 1 }))).toMatchObject({ verdict: 'clear', reason: 'boundary', command: '/clear' })
})

test('a saved plan over a sizeable context says clear and implement it fresh', () => {
  const advice = adviseSession(facts({ tokens: 85_000, planPath: '~/.claude/plans/calm-fox.md' }))
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'plan-ready', command: '/clear' })
  const warm = money(rewritePrice(opus, 85_000, 60).warm)
  expect(advice.text).toBe(`The plan is in ~/.claude/plans/calm-fox.md, and the 85k tokens of exploration behind it get re-read on every request (${warm} warm): /clear and ask Claude to implement the plan file in a fresh context.`)
  expect(adviseSession(facts({ tokens: 40_000, planPath: 'PLAN.md' })).verdict).toBe('continue')
})

test('a cold cache with steps open says what a handoff costs now', () => {
  const advice = adviseSession(facts({ tokens: 200_000, warmMinutes: 0, openSteps: 3 }))
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'cold' })
  expect(advice.text).toBe('The cache went cold: the next send, /compact included, re-writes 200k tokens for $1.60. /clear is free. 3 steps are open: a handoff keeps them, but writing it also pays the rewrite; with a plan file on disk, /clear and resume from it.')
})

test('two corrections in a row say start over', () => {
  const advice = adviseSession(facts({ tokens: 60_000, corrections: 2 }))
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'corrections', command: '/clear' })
  expect(advice.text).toBe('2 corrections in a row over 60k tokens: the failed attempts stay in context and steer the next try. /clear and start over with one prompt that says what you learned, or press Esc Esc to rewind to before the first attempt.')
  expect(adviseSession(facts({ tokens: 60_000, corrections: 1 })).verdict).toBe('continue')
  expect(adviseSession(facts({ tokens: 15_000, corrections: 5 })).verdict).toBe('continue')
})

test('nearing compact or a conversation-heavy context with steps open says handoff instead of compact', () => {
  const near = adviseSession(facts({ tokens: 700_000, openSteps: 4 }))
  expect(near).toMatchObject({ verdict: 'handoff', reason: 'near-compact' })
  expect(near.text).toBe(`100k tokens to auto-compact with 4 steps open: ${ASK_STEP}. A summary written mid-plan drops detail the next steps need.`)
  const talk = adviseSession(facts({ tokens: 500_000, messagesShare: 0.7, openSteps: 2, hasHandoffSkill: true }))
  expect(talk).toMatchObject({ verdict: 'handoff', reason: 'conversation', command: '/handoff' })
  expect(talk.text).toContain(`2 steps are open, so ${SKILL_STEP}.`)
  const plain = adviseSession(facts({ tokens: 500_000, messagesShare: 0.7 }))
  expect(plain).toMatchObject({ verdict: 'compact', command: '/compact' })
  expect(plain.text).toContain('Esc Esc → Summarize up to here condenses old turns and keeps recent ones whole')
})

test('a saved auto-handoff says clear and resume from it, ahead of every other rule', () => {
  const advice = adviseSession(facts({ tokens: 300_000, warmMinutes: 0, boundary: 'commit', openSteps: 4, handoffPath: '~/.claude/handoffs/r/2026-10-11-1432-ab12cd34.md' }))
  expect(advice).toMatchObject({ verdict: 'clear', reason: 'handoff-saved', command: '/clear' })
  expect(advice.text).toBe("Handoff saved to ~/.claude/handoffs/r/2026-10-11-1432-ab12cd34.md: /clear, then say 'resume from ~/.claude/handoffs/r/2026-10-11-1432-ab12cd34.md'.")
})

test('new rules keep their place in the order', () => {
  expect(adviseSession(facts({ tokens: 200_000, boundary: 'commit', planPath: 'PLAN.md' })).reason).toBe('boundary')
  expect(adviseSession(facts({ tokens: 200_000, warmMinutes: 0, planPath: 'PLAN.md' })).reason).toBe('plan-ready')
  expect(adviseSession(facts({ tokens: 200_000, warmMinutes: 0, corrections: 3 })).reason).toBe('cold')
  expect(adviseSession(facts({ tokens: 700_000, corrections: 2 })).reason).toBe('corrections')
})
