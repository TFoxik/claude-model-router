import { expect, test } from 'claude-code/testing'

import { MODELS, rewritePrice } from './routes'
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
