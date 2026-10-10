import type { Effort, Health, Lesson, LessonKind, PromptCost, PromptItem, Rewrite } from '../types'
import { ENGINE, FORK, GUARD_MIN_TOKENS, MODELS, PRICES_AS_OF, costOf, fmtAge, isLessonKind, isRouteKey, isSub, kTokens, labelOf, modelKeyOf, money, plural, printable, rewritePrice, routeText, sumUsd } from './routes'

export type LessonDraft = Pick<Lesson, 'kind' | 'fact' | 'usd'>
type Level = Health['ctxLevel']

export const SEEN_ENOUGH = 3
const TOAST_COOLDOWN_MS = 3_600_000
export const TOAST_MS = 8000
const PER_KIND = 20
export const MIN_REWRITE_USD = 0.05
const MIN_PROMPT_USD = 0.25
const PRICEY_SHARE = 0.7
const PRICEY_SAVING = 0.25
const SUB_SHARE = 0.5

export const CONCEPTS: Record<LessonKind, { title: string; body: string }> = {
  'cold-rewrite': {
    title: 'Cache went cold',
    body: 'Each request re-sends the whole conversation. A warm prompt cache lets the API read it back cheaply, at a tenth of the input price or less. The cache expires after the TTL (1 hour in Claude Code, 5 minutes on some setups). The first send after that writes everything again, at 1.25-2× input. Over a big context that one send can cost as much as a dozen or more warm turns. /clear and start from a short note, or come back before it expires.',
  },
  'switch-rewrite': {
    title: 'Switching model rewrote the cache',
    body: 'A prompt cache belongs to one model at one effort. Changing either, by hand, by a route or by plan mode, starts a new cache: the next request writes the whole context again. Switch at the start of a task, while the context is small, not in the middle of a long one.',
  },
  'pricey-model': {
    title: 'An expensive model did most of the work',
    body: 'Models differ in price per token: Opus costs about twice Sonnet for input and output, Fable more, and Haiku a fraction. Effort adds output (thinking) tokens. Use the top model where its judgement pays off (planning, tricky changes) and a cheaper one for routine edits or searches. Opus and Sonnet price cache reads the same, so between them the difference shows in output and cache writes.',
  },
  'context-high': {
    title: 'Context is getting big',
    body: 'Every turn sends the whole context again. Even read from the cache, a big context makes each turn cost more, and a cold send rewrites all of it. Near the limit Claude Code auto-compacts into a summary. Finishing a task and running /clear keeps turns cheap. /compact keeps a summary when you need the thread.',
  },
  compacted: {
    title: 'Conversation compacted',
    body: 'Compaction replaces the conversation with a summary written by the model. Later turns are cheaper because there is less to re-read, but anything the summary left out is gone. The summary is written to the cache once, like any new context.',
  },
  'cache-expiring': {
    title: 'Cache about to go cold',
    body: 'The prompt cache keeps the conversation cheap to re-send only for its TTL after the last request. Any send before it expires keeps it warm for another full TTL; after it expires, the next send writes the whole context again. If you are done for now, /clear costs nothing and the next session starts small. /route away compares the ways to step away, priced for the session.',
  },
  'plan-toggle': {
    title: 'Plan mode switches rewrite the cache',
    body: 'A prompt cache belongs to one model at one effort. When plan mode is routed differently from normal work, entering and leaving plan mode each start a new cache, and the first send after each switch writes the whole context again. Plan at the start of a task, while the context is small, or route plan and main the same.',
  },
  subagents: {
    title: 'Subagents did most of the spending',
    body: 'A subagent runs in its own fresh context. It has no cache to lose, so routing it to a cheaper model costs nothing up front. Each subagent re-reads the files it needs, so many parallel agents add up. Searches and reads usually do fine on a cheaper model: /route set sub:Explore sonnet.',
  },
}

export const TOPICS = Object.keys(CONCEPTS) as LessonKind[]
const RANK: Record<Level, number> = { success: 0, warning: 1, error: 2 }
export const isPricey = (model: string) => {
  const key = modelKeyOf(model)
  return key === 'opus' || key === 'fable'
}
const usageOf = (one: PromptItem) => ({
  input_tokens: one.input,
  output_tokens: one.output,
  cache_read_input_tokens: one.cacheRead,
  cache_creation_input_tokens: one.cacheWrite,
})
export const pct = (share: number) => `${Math.round(share * 100)}%`

type RewriteLessonFacts = {
  model: string
  ttlMinutes: number
  idleMs?: number
  from?: { model: string; effort?: Effort }
  to: { model: string; effort?: Effort }
}

/** A cache rewrite worth explaining: why it happened and what it cost against a warm read. */
export function lessonFromRewrite(rw: Rewrite, f: RewriteLessonFacts): LessonDraft | undefined {
  if (rw.usd < MIN_REWRITE_USD) return undefined
  const { write, warm } = rewritePrice(f.model, rw.tokens, f.ttlMinutes)
  if (rw.cause === 'cold') {
    const idle = f.idleMs === undefined ? '' : ` after ${fmtAge(f.idleMs)} idle`
    return {
      kind: 'cold-rewrite',
      usd: rw.usd,
      fact: `The cache had expired${idle}, so this send re-wrote ${kTokens(rw.tokens)} tokens on ${labelOf(f.model)} for ${money(write)}; read warm they would have cost ${money(warm)}.`,
    }
  }
  const from = f.from === undefined ? 'another route' : routeText(f.from.model, f.from.effort)
  return {
    kind: 'switch-rewrite',
    usd: rw.usd,
    fact: `Switching from ${from} to ${routeText(f.to.model, f.to.effort)} re-wrote ${kTokens(rw.tokens)} tokens for ${money(write)} (${money(rw.usd)} more than a warm read). Each model and effort keeps its own cache.`,
  }
}

function priceyLesson(p: PromptCost, ttlMinutes: number): LessonDraft | undefined {
  const pricey = p.items.filter(one => isPricey(one.model))
  if (pricey.some(one => one.isMixed)) return undefined
  const actual = sumUsd(pricey)
  const onSonnet = pricey.reduce((acc, one) => acc + costOf(usageOf(one), MODELS.sonnet.id, ttlMinutes), 0)
  if (p.usd < MIN_PROMPT_USD || actual < PRICEY_SHARE * p.usd || onSonnet > (1 - PRICEY_SAVING) * actual) return undefined
  const labels = [...new Set(pricey.map(one => labelOf(one.model)))].join(' and ')
  return {
    kind: 'pricey-model',
    usd: actual - onSonnet,
    fact: `${labels} did ${pct(actual / p.usd)} of this prompt's ${money(p.usd)}. The same tokens on ${MODELS.sonnet.label} would cost about ${money(onSonnet)} (price only, not quality).`,
  }
}

function subagentLesson(p: PromptCost): LessonDraft | undefined {
  // Forks share the parent's context and the engine's own agents are not routed: neither is a reroutable subagent.
  const subs = p.items.filter(one => isSub(one) && one.route !== FORK && one.route !== ENGINE)
  const subUsd = sumUsd(subs)
  if (subs.length < 2 || p.usd < MIN_PROMPT_USD || subUsd < SUB_SHARE * p.usd) return undefined
  const byRoute = new Map<string, number>()
  for (const one of subs) byRoute.set(one.route, (byRoute.get(one.route) ?? 0) + one.usd)
  const route = [...byRoute.entries()].sort((a, b) => b[1] - a[1])[0]![0]
  const top = subs.filter(one => one.route === route).sort((a, b) => b.usd - a.usd)[0]!
  const shown = printable(route)
  const hint = route.startsWith('sub:') && isRouteKey(route) && isPricey(top.model)
    ? `Subagents start with a fresh context, so moving ${shown} to a cheaper model costs no cache rewrite: /route set ${shown} sonnet`
    : 'Subagents start with a fresh context, so they never pay a cache rewrite when rerouted.'
  return {
    kind: 'subagents',
    usd: subUsd,
    fact: `${plural(subs.length, 'subagent')} made up ${pct(subUsd / p.usd)} of this prompt (${money(subUsd)}), most of it ${shown} on ${labelOf(top.model)}. ${hint}`,
  }
}

/** The lessons a finished prompt's cost breakdown holds. */
export function lessonsFromPrompt(p: PromptCost, ttlMinutes: number): LessonDraft[] {
  return [priceyLesson(p, ttlMinutes), subagentLesson(p)].filter((one): one is LessonDraft => one !== undefined)
}

/** Context crossing into amber or red, priced per turn ahead on the model the main loop runs; measured against auto-compact when it is on. */
export function lessonFromContext(
  prev: Level | undefined,
  next: Level,
  tokens: number,
  model: string,
  ttlMinutes: number,
  hasAutoCompact: boolean,
): LessonDraft | undefined {
  if (prev === undefined || RANK[next] <= RANK[prev] || next === 'success' || modelKeyOf(model) === undefined) return undefined
  const { write, warm } = rewritePrice(model, tokens, ttlMinutes)
  const share = next === 'error' ? '85%' : '60%'
  const how = hasAutoCompact ? `past ${share} of the way to auto-compact` : `past ${share} of the context window`
  return {
    kind: 'context-high',
    usd: warm,
    fact: `Context reached ${kTokens(tokens)} tokens, ${how}. From here every turn re-reads all of it: about ${money(warm)} a turn on ${labelOf(model)} while the cache is warm, ${money(write)} if it goes cold. Finishing this task and running /clear brings that back down.`,
  }
}

/** Minutes before expiry the warning fires: enough to send something, scaled to the TTL. */
const warnMinutes = (ttlMinutes: number) => (ttlMinutes >= 60 ? 5 : 2)

/** The cache's last minutes over a big context, while a send still keeps it warm. */
export function lessonFromExpiry(prevWarm: number | undefined, warm: number, ttlMinutes: number, tokens: number, model: string): LessonDraft | undefined {
  const at = warnMinutes(ttlMinutes)
  if (prevWarm === undefined || prevWarm <= at || warm > at || warm <= 0 || tokens < GUARD_MIN_TOKENS || modelKeyOf(model) === undefined) return undefined
  const price = rewritePrice(model, tokens, ttlMinutes)
  return {
    kind: 'cache-expiring',
    usd: price.premium,
    fact: `The prompt cache goes cold in ${warm}m. A send before then reads the ${kTokens(tokens)} tokens for ${money(price.warm)}; after, it re-writes them on ${labelOf(model)} for ${money(price.write)}. Leaving for longer? /route away`,
  }
}

type LoopRoute = { model: string; effort?: string }

/** What each switch between differently routed plan mode and normal work re-writes, at the current context. */
export function lessonFromPlanToggle(plan: LoopRoute, main: LoopRoute, tokens: number, ttlMinutes: number): LessonDraft | undefined {
  if (plan.model === main.model && plan.effort === main.effort) return undefined
  const enter = rewritePrice(plan.model, tokens, ttlMinutes).write
  const leave = rewritePrice(main.model, tokens, ttlMinutes).write
  if (Math.min(enter, leave) < MIN_REWRITE_USD) return undefined
  return {
    kind: 'plan-toggle',
    usd: enter + leave,
    fact: `Plan mode runs on ${routeText(plan.model, plan.effort)} and normal work on ${routeText(main.model, main.effort)}, so each switch re-writes the cache: at ${kTokens(tokens)} tokens, entering cost about ${money(enter)} and leaving will cost about ${money(leave)}. Routing both the same avoids it; so does switching while the context is small.`,
  }
}

export function lessonFromCompact(beforeTokens: number): LessonDraft {
  const from = beforeTokens > 0 ? ` from about ${kTokens(beforeTokens)} tokens` : ''
  return {
    kind: 'compacted',
    fact: `The conversation was compacted${from} down to a summary. Turns now re-read far less, but details the summary left out are gone.`,
  }
}

/** The one fresh lesson worth a toast: costliest first, skipping kinds toasted enough or within the cooldown. */
export function pickToast(fresh: readonly Lesson[], earlier: readonly Lesson[], now: number): Lesson | undefined {
  const due = fresh.filter(one => {
    const before = earlier.filter(e => e.kind === one.kind)
    const toasted = before.filter(e => e.isToasted)
    const lastToast = Math.max(-Infinity, ...toasted.map(e => e.at))
    return toasted.length < SEEN_ENOUGH && now - lastToast >= TOAST_COOLDOWN_MS
  })
  return [...due].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0]
}

export function toastText(one: Lesson, earlier: readonly Lesson[]): string {
  const isFirst = !earlier.some(e => e.kind === one.kind && e.isToasted)
  return `${isFirst ? `${CONCEPTS[one.kind].title}: ` : '▸ '}${one.fact} · /route learn`
}

/**
 * Lessons the band counts as unread: those that toasted, and those of a kind that has not toasted yet.
 * Quiet repeats of a kind already taught (a routed Opus main loop teaches pricey-model every prompt) stay in the pane only.
 */
export function unreadCount(lessons: readonly Lesson[], readAt: number, muted: readonly LessonKind[]): number {
  const taught = new Set(lessons.filter(one => one.isToasted).map(one => one.kind))
  return lessons.filter(one => one.at > readAt && !muted.includes(one.kind) && (one.isToasted || !taught.has(one.kind))).length
}

/** The last PER_KIND lessons of each kind, so a lesson that fires every prompt can't crowd out the rest. */
export function capLessons(list: readonly Lesson[]): Lesson[] {
  const counts = new Map<LessonKind, number>()
  const kept: Lesson[] = []
  for (let i = list.length - 1; i >= 0; i--) {
    const one = list[i]!
    const n = counts.get(one.kind) ?? 0
    if (n >= PER_KIND) continue
    counts.set(one.kind, n + 1)
    kept.push(one)
  }
  return kept.reverse()
}

const isLesson = (l: unknown): l is Lesson => {
  const x = l as Lesson | null
  return typeof x === 'object' && x !== null && isLessonKind(x.kind) && typeof x.at === 'number' && typeof x.repo === 'string' && typeof x.fact === 'string'
}

export const sanitizeLessons = (stored: unknown): Lesson[] =>
  Array.isArray(stored) ? capLessons(stored.filter(isLesson)).map(one => ({ ...one, repo: printable(one.repo), fact: printable(one.fact) })) : []

/** Kinds ordered by their newest lesson, each with its lessons newest first. */
export function byKind(lessons: readonly Lesson[]): Array<[LessonKind, Lesson[]]> {
  const groups = new Map<LessonKind, Lesson[]>()
  for (const one of [...lessons].sort((a, b) => b.at - a.at)) {
    const group = groups.get(one.kind)
    if (group === undefined) groups.set(one.kind, [one])
    else group.push(one)
  }
  return [...groups.entries()]
}

const NOTE_TOKENS = 1_000
const SUMMARY_TOKENS = 4_000

type AwayFacts = { tokens: number; model: string; ttlMinutes: number; warmMinutes: number }

/** The ways to step away from a session, priced for its context, routed model and cache state. */
export function awayText(f: AwayFacts): string {
  const key = modelKeyOf(f.model)
  if (key === undefined) {
    return `No prices for ${f.model}. Before a long break: have Claude write the work in progress to a note, /rename, then /clear; or /compact while the cache is warm.`
  }
  const out = (tokens: number) => (tokens * MODELS[key].output) / 1e6
  const { write, warm } = rewritePrice(f.model, f.tokens, f.ttlMinutes)
  const ctx = `${kTokens(f.tokens)} tokens of context on ${labelOf(f.model)}`
  if (f.warmMinutes <= 0) {
    return [
      `${ctx}. The cache is already cold: anything sent now re-writes the ${kTokens(f.tokens)} tokens for ${money(write)}, so /clear (free) is the cheapest way out.`,
      'To keep the work: /rename first and /resume later (Pro and Max offer to resume from a summary), or pay the rewrite once and ask Claude for a note before /clear.',
    ].join('\n')
  }
  const row = (name: string, now: string, back: string, how: string) => `  ${name.padEnd(18)}${now.padEnd(16)}${back.padEnd(22)}${how}`
  return [
    `${ctx}, cache warm for ${f.warmMinutes}m more (${f.ttlMinutes}-minute TTL).`,
    '',
    row('Note + /clear', `now ≈ ${money(warm + out(NOTE_TOKENS))}`, 'on return ≈ $0.00', 'Ask Claude to write the work in progress to a file, /rename, /clear; start the next session from the note.'),
    row(
      '/compact',
      `now ≈ ${money(warm + out(SUMMARY_TOKENS))}`,
      `on return ≈ ${money(rewritePrice(f.model, SUMMARY_TOKENS, f.ttlMinutes).write)}`,
      'Say what to keep: /compact keep the plan, open TODOs and touched files. Only while warm: cold, it reads everything at full price.',
    ),
    row('/rename, /resume', 'now   $0.00', 'on return: summary', 'On Pro and Max, /resume of a big session offers to continue from a summary.'),
    row('Keep warm', `${money(warm * Math.ceil(60 / f.ttlMinutes))} an hour`, '', 'An idle ping before each expiry (cache-tax does this); pays off for a few hours, not overnight.'),
    row('Do nothing', 'now   $0.00', `on return   ${money(write)}`, 'The first send re-writes the whole context.'),
    '',
    `Prices as of ${PRICES_AS_OF}, estimates; ≈ also guesses the note (${kTokens(NOTE_TOKENS)}) and summary (${kTokens(SUMMARY_TOKENS)}) sizes.`,
  ].join('\n')
}
