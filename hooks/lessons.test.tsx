import { expect, test } from 'claude-code/testing'

import type { Lesson, PromptCost, PromptItem } from '../types'
import {
  CONCEPTS,
  HABITS,
  TOPICS,
  awayOptions,
  awayText,
  byKind,
  capLessons,
  lessonFromAdvice,
  lessonFromAutoHandoff,
  lessonFromCompact,
  lessonFromContext,
  lessonFromExpiry,
  lessonFromExploration,
  lessonFromPlanToggle,
  lessonFromRewrite,
  lessonsFromPrompt,
  pickToast,
  sanitizeLessons,
  toastText,
  unreadCount,
} from './lessons'
import { MODELS } from './routes'
import { adviseSession } from './strategy'

const opus = MODELS.opus.id
const sonnet = MODELS.sonnet.id
const T0 = Date.parse('2026-10-08T10:00:00Z')
const HOUR = 3_600_000

const item = (over: Partial<PromptItem>): PromptItem => ({
  id: 'main', route: 'main', label: 'Main loop', model: opus,
  requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, ...over,
})
const lesson = (over: Partial<Lesson>): Lesson => ({ kind: 'cold-rewrite', at: T0, repo: 'r', fact: 'f', ...over })
/** Drafts with `usd` rounded to the cent, so float sums compare exactly. */
const cents = <T extends { usd?: number }>(xs: readonly T[]) => xs.map(x => (x.usd === undefined ? x : { ...x, usd: Math.round(x.usd * 100) / 100 }))

test('rewrite lessons: cold and switch, with the real numbers', () => {
  expect(lessonFromRewrite({ cause: 'cold', tokens: 100_000, usd: 0.78 }, { model: opus, ttlMinutes: 60, idleMs: 61 * 60_000, to: { model: opus } })).toEqual({
    kind: 'cold-rewrite',
    usd: 0.78,
    fact: 'The cache had expired after 1h01m idle, so this send re-wrote 100k tokens on Opus 5.5 for $0.80; read warm they would have cost $0.02.',
  })
  expect(
    lessonFromRewrite(
      { cause: 'switch', tokens: 100_000, usd: 0.38 },
      { model: sonnet, ttlMinutes: 60, from: { model: opus, effort: 'medium' }, to: { model: sonnet, effort: 'high' } },
    ),
  ).toEqual({
    kind: 'switch-rewrite',
    usd: 0.38,
    fact: 'Switching from Opus 5.5 medium to Sonnet 5.5 high re-wrote 100k tokens for $0.40 ($0.38 more than a warm read). Each model and effort keeps its own cache.',
  })
  expect(lessonFromRewrite({ cause: 'cold', tokens: 25_000, usd: 0.03 }, { model: opus, ttlMinutes: 60, to: { model: opus } })).toBeUndefined()
})

test('pricey-model lesson: a big Opus share, priced on Sonnet, only when Sonnet is clearly cheaper', () => {
  const pricey = item({ output: 10_000, cacheWrite: 50_000, usd: 0.6 })
  expect(cents(lessonsFromPrompt({ usd: 0.6, requests: 1, items: [pricey] }, 60))).toEqual([
    {
      kind: 'pricey-model',
      usd: 0.3,
      fact: "Opus 5.5 did 100% of this prompt's $0.60. The same tokens on Sonnet 5.5 would cost about $0.30 (price only, not quality).",
    },
  ])
  const readHeavy = item({ cacheRead: 2_000_000, usd: 0.4 })
  expect(lessonsFromPrompt({ usd: 0.4, requests: 1, items: [readHeavy] }, 60)).toEqual([])
  const small = item({ output: 5_000, usd: 0.1 })
  expect(lessonsFromPrompt({ usd: 0.1, requests: 1, items: [small] }, 60)).toEqual([])
  const mixed = item({ output: 10_000, cacheWrite: 50_000, usd: 0.6, isMixed: true })
  expect(lessonsFromPrompt({ usd: 0.45, requests: 2, items: [mixed] }, 60)).toEqual([])
  const unknown = item({ model: 'gpt-something', output: 100_000, usd: 2 })
  expect(lessonsFromPrompt({ usd: 2, requests: 1, items: [unknown] }, 60)).toEqual([])
})

test('subagents lesson: share, the busiest route, and a reroute hint only for sub: routes on a pricey model', () => {
  const subagentLessons = (p: PromptCost, ttl: number) => lessonsFromPrompt(p, ttl).filter(one => one.kind === 'subagents')
  const items = [
    item({ usd: 0.2 }),
    item({ id: 'a-1', route: 'sub:Explore', label: 'Explore · find', usd: 0.5 }),
    item({ id: 'a-2', route: 'sub:Explore', label: 'Explore · grep', usd: 0.3 }),
  ]
  expect(cents(subagentLessons({ usd: 1, requests: 3, items }, 60))).toEqual([
    {
      kind: 'subagents',
      usd: 0.8,
      fact: '2 subagents made up 80% of this prompt ($0.80), most of it sub:Explore on Opus 5.5. Subagents start with a fresh context, so moving sub:Explore to a cheaper model costs no cache rewrite: /route set sub:Explore sonnet',
    },
  ])
  const onHaiku = items.map(one => (one.id === 'main' ? one : { ...one, model: MODELS.haiku.id }))
  expect(subagentLessons({ usd: 1, requests: 3, items: onHaiku }, 60)[0]!.fact).toBe(
    '2 subagents made up 80% of this prompt ($0.80), most of it sub:Explore on Haiku 5.5. Subagents start with a fresh context, so they never pay a cache rewrite when rerouted.',
  )
  const weird = items.map(one => (one.id === 'main' ? one : { ...one, route: 'sub:x\u001b[2J' }))
  expect(subagentLessons({ usd: 1, requests: 3, items: weird }, 60)[0]!.fact).not.toContain('\u001b')
  expect(subagentLessons({ usd: 1, requests: 2, items: items.slice(0, 2) }, 60)).toEqual([])
  const cheap = items.map(one => ({ ...one, usd: one.usd / 100 }))
  expect(subagentLessons({ usd: 0.01, requests: 3, items: cheap }, 60)).toEqual([])
  const notRoutable = [item({ usd: 0.2 }), item({ id: 'compact-1', route: 'engine', usd: 0.5 }), item({ id: 'f-1', route: 'fork', usd: 0.3 })]
  expect(subagentLessons({ usd: 1, requests: 3, items: notRoutable }, 60)).toEqual([])
})

test('context lesson: a heads-up when the level rises, never on the first reading or an unknown model', () => {
  expect(cents([lessonFromContext('success', 'warning', 300_000, opus, 60, true)!])[0]).toEqual({
    kind: 'context-high',
    usd: 0.06,
    fact: 'Context reached 300k tokens, past 60% of the way to auto-compact. From here every turn re-reads all of it: about $0.06 a turn on Opus 5.5 while the cache is warm, $2.40 if it goes cold. Finishing this task and running /clear brings that back down.',
  })
  expect(lessonFromContext('warning', 'error', 300_000, opus, 60, true)!.fact).toMatch(/^Context reached 300k tokens, past 85% of the way to auto-compact\./)
  expect(lessonFromContext('success', 'warning', 300_000, opus, 60, false)!.fact).toMatch(/^Context reached 300k tokens, past 60% of the context window\./)
  expect(lessonFromContext(undefined, 'error', 300_000, opus, 60, true)).toBeUndefined()
  expect(lessonFromContext('warning', 'warning', 300_000, opus, 60, true)).toBeUndefined()
  expect(lessonFromContext('error', 'warning', 300_000, opus, 60, true)).toBeUndefined()
  expect(lessonFromContext('success', 'warning', 300_000, 'gpt-something', 60, true)).toBeUndefined()
})

test('expiry lesson: once, as the warm time crosses the warning mark, over a big context', () => {
  expect(cents([lessonFromExpiry(6, 5, 60, 200_000, opus)!])[0]).toEqual({
    kind: 'cache-expiring',
    usd: 1.56,
    fact: 'The prompt cache goes cold in 5m. A send before then reads the 200k tokens for $0.04; after, it re-writes them on Opus 5.5 for $1.60. Leaving for longer? /route away',
  })
  expect(lessonFromExpiry(6, 4, 60, 200_000, opus)!.fact).toMatch(/^The prompt cache goes cold in 4m\./)
  expect(lessonFromExpiry(3, 2, 5, 200_000, opus)!.fact).toBe(
    'The prompt cache goes cold in 2m. A send before then reads the 200k tokens for $0.04; after, it re-writes them on Opus 5.5 for $1.00. Leaving for longer? /route away',
  )
  expect(lessonFromExpiry(5, 5, 60, 200_000, opus)).toBeUndefined()
  expect(lessonFromExpiry(undefined, 5, 60, 200_000, opus)).toBeUndefined()
  expect(lessonFromExpiry(6, 0, 60, 200_000, opus)).toBeUndefined()
  expect(lessonFromExpiry(6, 5, 60, 40_000, opus)).toBeUndefined()
  expect(lessonFromExpiry(6, 5, 60, 200_000, 'gpt-something')).toBeUndefined()
})

test('plan toggle lesson: the cost of each switch, only when plan and main differ', () => {
  const plan = { model: opus, effort: 'high' }
  const main = { model: opus, effort: 'medium' }
  expect(cents([lessonFromPlanToggle(plan, main, 200_000, 60)!])[0]).toEqual({
    kind: 'plan-toggle',
    usd: 3.2,
    fact: 'Plan mode runs on Opus 5.5 high and normal work on Opus 5.5 medium, so each switch re-writes the cache: at 200k tokens, entering cost about $1.60 and leaving will cost about $1.60. Routing both the same avoids it; so does switching while the context is small.',
  })
  expect(lessonFromPlanToggle({ model: sonnet, effort: 'high' }, main, 200_000, 60)!.fact).toMatch(/entering cost about \$0\.80 and leaving will cost about \$1\.60\./)
  expect(lessonFromPlanToggle(main, main, 200_000, 60)).toBeUndefined()
  expect(lessonFromPlanToggle(plan, main, 5_000, 60)).toBeUndefined()
  expect(lessonFromPlanToggle({ model: 'gpt-x', effort: 'high' }, { model: 'gpt-x' }, 200_000, 60)).toBeUndefined()
})

test('compaction lesson', () => {
  expect(lessonFromCompact(180_000)).toEqual({
    kind: 'compacted',
    fact: 'The conversation was compacted from about 180k tokens down to a summary. Turns now re-read far less, but details the summary left out are gone.',
  })
  expect(lessonFromCompact(0).fact).toBe('The conversation was compacted down to a summary. Turns now re-read far less, but details the summary left out are gone.')
})

test('pickToast: costliest fresh lesson, not one toasted 3 times, not within the hour', () => {
  const cold = lesson({ kind: 'cold-rewrite', at: T0, usd: 0.78 })
  const ctx = lesson({ kind: 'context-high', at: T0, usd: 0.06 })
  expect(pickToast([ctx, cold], [], T0)).toBe(cold)
  const seen3 = [1, 2, 3].map(i => lesson({ kind: 'cold-rewrite', at: T0 - i * 2 * HOUR, isToasted: true }))
  expect(pickToast([ctx, cold], seen3, T0)).toBe(ctx)
  const keptNotToasted = [1, 2, 3].map(i => lesson({ kind: 'cold-rewrite', at: T0 - i * 2 * HOUR }))
  expect(pickToast([ctx, cold], keptNotToasted, T0)).toBe(cold)
  const toastedRecently = [lesson({ kind: 'cold-rewrite', at: T0 - 30 * 60_000, isToasted: true })]
  expect(pickToast([ctx, cold], toastedRecently, T0)).toBe(ctx)
  const toastedLongAgo = [lesson({ kind: 'cold-rewrite', at: T0 - HOUR, isToasted: true })]
  expect(pickToast([ctx, cold], toastedLongAgo, T0)).toBe(cold)
  expect(pickToast([], [], T0)).toBeUndefined()
})

test('toastText leads with the concept title until the kind has toasted once', () => {
  const cold = lesson({ fact: 'X.' })
  expect(toastText(cold, [])).toBe('Cache went cold: X. · /route learn')
  expect(toastText(cold, [lesson({})])).toBe('Cache went cold: X. · /route learn')
  expect(toastText(cold, [lesson({ isToasted: true })])).toBe('▸ X. · /route learn')
})

test('unreadCount: new and toasted lessons, not quiet repeats or muted kinds', () => {
  const toasted = lesson({ kind: 'pricey-model', at: T0, isToasted: true })
  const repeats = [1, 2, 3].map(i => lesson({ kind: 'pricey-model', at: T0 + i }))
  const neverToasted = lesson({ kind: 'subagents', at: T0 + 4 })
  const all = [toasted, ...repeats, neverToasted]
  expect(unreadCount(all, 0, [])).toBe(2)
  expect(unreadCount(all, T0, [])).toBe(1)
  expect(unreadCount(all, 0, ['subagents'])).toBe(1)
  expect(unreadCount(all, 0, ['pricey-model', 'subagents'])).toBe(0)
})

test('capLessons keeps the last 20 of each kind, in order', () => {
  const many = Array.from({ length: 30 }, (_, i) => lesson({ kind: 'pricey-model', at: i }))
  const mixed = [lesson({ kind: 'cold-rewrite', at: -1 }), ...many]
  const kept = capLessons(mixed)
  expect(kept.length).toBe(21)
  expect(kept[0]!.kind).toBe('cold-rewrite')
  expect(kept[1]!.at).toBe(10)
  expect(kept[20]!.at).toBe(29)
})

test('sanitizeLessons drops what this version does not understand', () => {
  const good = lesson({})
  expect(sanitizeLessons([good, null, { ...good, kind: 'nope' }, { ...good, fact: 3 }, 'x'])).toEqual([good])
  expect(sanitizeLessons({})).toEqual([])
  expect(sanitizeLessons([lesson({ repo: 'r\u001b', fact: 'f\u0007' })])).toEqual([lesson({ repo: 'r ', fact: 'f ' })])
})

test('byKind groups newest first', () => {
  const a = lesson({ kind: 'cold-rewrite', at: 1 })
  const b = lesson({ kind: 'subagents', at: 2 })
  const c = lesson({ kind: 'cold-rewrite', at: 3 })
  expect(byKind([a, b, c])).toEqual([['cold-rewrite', [c, a]], ['subagents', [b]]])
})

test('awayText prices the ways to step away for this session', () => {
  const warm = awayText({ tokens: 200_000, model: opus, ttlMinutes: 60, warmMinutes: 42 })
  expect(warm).toContain('200k tokens of context on Opus 5.5, cache warm for 42m more (60-minute TTL).')
  expect(warm).toMatch(/Note \+ \/clear +now ≈ \$0\.06 +on return ≈ \$0\.00/)
  expect(warm).toMatch(/\/compact +now ≈ \$0\.12 +on return ≈ \$0\.03/)
  expect(warm).toMatch(/Keep warm +\$0\.04 an hour/)
  expect(warm).toMatch(/Do nothing +now +\$0\.00 +on return +\$1\.60/)
  const short = awayText({ tokens: 200_000, model: opus, ttlMinutes: 5, warmMinutes: 3 })
  expect(short).toMatch(/Keep warm +\$0\.48 an hour/)
  const cold = awayText({ tokens: 200_000, model: opus, ttlMinutes: 60, warmMinutes: 0 })
  expect(cold).toContain('The cache is already cold: anything sent now re-writes the 200k tokens for $1.60, so /clear (free) is the cheapest way out.')
  expect(awayText({ tokens: 200_000, model: 'gpt-x', ttlMinutes: 60, warmMinutes: 10 })).toMatch(/^No prices for gpt-x\./)
})

test('awayOptions gives the same ways to step away as rows, and none when cold or unpriced', () => {
  const warm = awayOptions({ tokens: 200_000, model: opus, ttlMinutes: 60, warmMinutes: 42 })
  expect(warm.header).toBe('200k tokens of context on Opus 5.5, cache warm for 42m more (60-minute TTL).')
  expect(warm.rows.map(one => one.name)).toEqual(['Note + /clear', '/compact', '/rename, /resume', 'Keep warm', 'Do nothing'])
  expect(warm.rows[1]).toMatchObject({ now: 'now ≈ $0.12', back: 'on return ≈ $0.03' })
  expect(warm.notes).toHaveLength(1)
  const cold = awayOptions({ tokens: 200_000, model: opus, ttlMinutes: 60, warmMinutes: 0 })
  expect([cold.rows.length, cold.notes.length]).toEqual([0, 1])
  expect(awayOptions({ tokens: 200_000, model: 'gpt-x', ttlMinutes: 60, warmMinutes: 10 })).toMatchObject({ rows: [], notes: [] })
})

test('advice teaches when a commit makes clearing the better move, once', () => {
  const advice = adviseSession({ tokens: 200_000, window: 1_000_000, model: opus, ttlMinutes: 60, warmMinutes: 40, boundary: 'commit' })
  expect(lessonFromAdvice({ verdict: 'continue', reason: 'fine' }, advice)).toEqual({ kind: 'strategy', usd: advice.perRequestUsd, fact: advice.text })
  expect(lessonFromAdvice({ verdict: 'clear', reason: 'boundary' }, advice)).toBeUndefined()
  expect(lessonFromAdvice(undefined, adviseSession({ tokens: 200_000, window: 1_000_000, model: opus, ttlMinutes: 60, warmMinutes: 0 }))).toBeUndefined()
  expect(lessonFromAdvice(undefined, adviseSession({ tokens: 100_000, window: 1_000_000, model: opus, ttlMinutes: 60, warmMinutes: 40 }))).toBeUndefined()
  expect(lessonFromAdvice(undefined, adviseSession({ tokens: 900_000, window: 1_000_000, model: opus, ttlMinutes: 60, warmMinutes: 40 }))).toBeUndefined()
})

test('a handoff, a saved plan and repeated corrections each teach on first appearance', () => {
  const base = { window: 1_000_000, model: opus, ttlMinutes: 60, warmMinutes: 40 }
  const handoff = adviseSession({ ...base, tokens: 200_000, boundary: 'commit', openSteps: 3 })
  expect(lessonFromAdvice(undefined, handoff)?.kind).toBe('handoff')
  expect(lessonFromAdvice({ verdict: 'handoff', reason: 'near-compact' }, handoff)).toBeUndefined()
  const plan = adviseSession({ ...base, tokens: 200_000, planPath: 'PLAN.md' })
  expect(lessonFromAdvice(undefined, plan)).toEqual({ kind: 'plan-ready', usd: plan.perRequestUsd, fact: plan.text })
  const fixes = adviseSession({ ...base, tokens: 200_000, corrections: 2 })
  expect(lessonFromAdvice({ verdict: 'clear', reason: 'boundary' }, fixes)?.kind).toBe('corrections')
  expect(lessonFromAdvice({ verdict: 'clear', reason: 'corrections' }, fixes)).toBeUndefined()
})

test('exploration and auto-handoff lessons carry their numbers', () => {
  expect(lessonFromExploration(42_000, 120_000)).toEqual({
    kind: 'exploration',
    fact: 'File reads and searches put 42k tokens (35%) into the main context this session. A subagent reads in its own context and hands back a summary.',
  })
  expect(lessonFromAutoHandoff({ spentUsd: 0.04, avoidedUsd: 0.52, tokens: 140_000, path: '~/.claude/handoffs/r/x.md' })).toEqual({
    kind: 'auto-handoff',
    usd: 0.48,
    fact: 'Saved a handoff to ~/.claude/handoffs/r/x.md for $0.04 before the cache went cold. Resending 140k tokens cold would have cost $0.52. /route handoffs auto off turns this off.',
  })
  expect(lessonFromAutoHandoff({ spentUsd: 0, avoidedUsd: 0, tokens: 140_000, path: 'x.md' }).fact).toBe('Saved a handoff to x.md before the cache went cold. /route handoffs auto off turns this off.')
})

test('every lesson kind has a concept, and the habits are the three agreed', () => {
  for (const kind of TOPICS) expect(CONCEPTS[kind].title.length).toBeGreaterThan(0)
  expect(TOPICS).toContain('auto-handoff')
  expect(HABITS.map(one => one.title)).toEqual(['/clear between unrelated tasks', '/btw for side questions', 'Esc Esc to rewind'])
})
