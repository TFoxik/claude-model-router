import { expect, test } from 'claude-code/testing'

import type { Lesson, PromptItem } from '../types'
import {
  byKind,
  capLessons,
  lessonFromCompact,
  lessonFromContext,
  lessonFromRewrite,
  lessonsFromPrompt,
  pickToast,
  sanitizeLessons,
  toastText,
} from './lessons'
import { MODELS } from './routes'

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
  const unknown = item({ model: 'gpt-something', output: 100_000, usd: 2 })
  expect(lessonsFromPrompt({ usd: 2, requests: 1, items: [unknown] }, 60)).toEqual([])
})

test('subagents lesson: share, the busiest route, and a reroute hint only for sub: routes on a pricey model', () => {
  const items = [
    item({ usd: 0.2 }),
    item({ id: 'a-1', route: 'sub:Explore', label: 'Explore · find', usd: 0.5 }),
    item({ id: 'a-2', route: 'sub:Explore', label: 'Explore · grep', usd: 0.3 }),
  ]
  expect(cents(lessonsFromPrompt({ usd: 1, requests: 3, items }, 60))).toEqual([
    {
      kind: 'subagents',
      usd: 0.8,
      fact: '2 subagents made up 80% of this prompt ($0.80), most of it sub:Explore on Opus 5.5. Subagents start with a fresh context, so moving sub:Explore to a cheaper model costs no cache rewrite: /route set sub:Explore sonnet',
    },
  ])
  const onHaiku = items.map(one => (one.id === 'main' ? one : { ...one, model: MODELS.haiku.id }))
  expect(lessonsFromPrompt({ usd: 1, requests: 3, items: onHaiku }, 60)[0]!.fact).toBe(
    '2 subagents made up 80% of this prompt ($0.80), most of it sub:Explore on Haiku 5.5. Subagents start with a fresh context, so they never pay a cache rewrite when rerouted.',
  )
  const weird = items.map(one => (one.id === 'main' ? one : { ...one, route: 'sub:x\u001b[2J' }))
  expect(lessonsFromPrompt({ usd: 1, requests: 3, items: weird }, 60)[0]!.fact).not.toContain('\u001b')
  expect(lessonsFromPrompt({ usd: 1, requests: 2, items: items.slice(0, 2) }, 60)).toEqual([])
})

test('context lesson: only when the level rises, never on the first reading or an unknown model', () => {
  expect(cents([lessonFromContext('success', 'warning', 300_000, opus, 60)!])[0]).toEqual({
    kind: 'context-high',
    usd: 0.06,
    fact: 'Context reached 300k tokens, past 60% of the way to auto-compact. Every turn re-reads all of it: about $0.06 a turn on Opus 5.5 while the cache is warm, $2.40 if it has gone cold.',
  })
  expect(lessonFromContext('warning', 'error', 300_000, opus, 60)!.fact).toMatch(/^Context reached 300k tokens, past 85% of the way to auto-compact\./)
  expect(lessonFromContext(undefined, 'error', 300_000, opus, 60)).toBeUndefined()
  expect(lessonFromContext('warning', 'warning', 300_000, opus, 60)).toBeUndefined()
  expect(lessonFromContext('error', 'warning', 300_000, opus, 60)).toBeUndefined()
  expect(lessonFromContext('success', 'warning', 300_000, 'gpt-something', 60)).toBeUndefined()
})

test('compaction lesson', () => {
  expect(lessonFromCompact(180_000)).toEqual({
    kind: 'compacted',
    fact: 'The conversation was compacted from about 180k tokens down to a summary. Turns now re-read far less, but details the summary left out are gone.',
  })
  expect(lessonFromCompact(0).fact).toBe('The conversation was compacted down to a summary. Turns now re-read far less, but details the summary left out are gone.')
})

test('pickToast: costliest fresh lesson, not one seen 3 times, not within the hour', () => {
  const cold = lesson({ kind: 'cold-rewrite', at: T0, usd: 0.78 })
  const ctx = lesson({ kind: 'context-high', at: T0, usd: 0.06 })
  expect(pickToast([ctx, cold], [], T0)).toBe(cold)
  const seen3 = [1, 2, 3].map(i => lesson({ kind: 'cold-rewrite', at: T0 - i * 2 * HOUR }))
  expect(pickToast([ctx, cold], seen3, T0)).toBe(ctx)
  const toastedRecently = [lesson({ kind: 'cold-rewrite', at: T0 - 30 * 60_000, isToasted: true })]
  expect(pickToast([ctx, cold], toastedRecently, T0)).toBe(ctx)
  const toastedLongAgo = [lesson({ kind: 'cold-rewrite', at: T0 - HOUR, isToasted: true })]
  expect(pickToast([ctx, cold], toastedLongAgo, T0)).toBe(cold)
  expect(pickToast([], [], T0)).toBeUndefined()
})

test('toastText leads with the concept title the first time only', () => {
  const cold = lesson({ fact: 'X.' })
  expect(toastText(cold, [])).toBe('Cache went cold: X. · /route learn')
  expect(toastText(cold, [lesson({})])).toBe('▸ X. · /route learn')
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
})

test('byKind groups newest first', () => {
  const a = lesson({ kind: 'cold-rewrite', at: 1 })
  const b = lesson({ kind: 'subagents', at: 2 })
  const c = lesson({ kind: 'cold-rewrite', at: 3 })
  expect(byKind([a, b, c])).toEqual([['cold-rewrite', [c, a]], ['subagents', [b]]])
})
