import type { Effort, Health, LearnCard, Lesson, LessonKind, PromptCost, PromptItem, Rewrite } from '../types'
import type { Advice } from './strategy'
import { ENGINE, FORK, GUARD_MIN_TOKENS, MODELS, PRICES_AS_OF, costOf, fmtAge, isLessonKind, isRouteKey, isSub, kTokens, labelOf, modelKeyOf, money, plural, printable, rewritePrice, routeText, sumUsd } from './routes'

export type LessonDraft = Pick<Lesson, 'kind' | 'fact' | 'usd'>
type Level = Health['ctxLevel']

const SEEN_ENOUGH = 3
const TOAST_COOLDOWN_MS = 3_600_000
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
    body: 'Every turn sends the whole context again. Even read from the cache, a big context makes each turn cost more, and a cold send rewrites all of it. Near the limit Claude Code auto-compacts into a summary. Finishing a task and running /clear keeps turns cheap. /compact keeps a summary when you need the thread: say what to keep (the plan, open TODOs, touched files), and run it at a point you choose, while the cache is warm, rather than let auto-compact fire mid-task.',
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
  strategy: {
    title: 'Clear after committing',
    body: 'Every request re-sends the whole conversation, so what has piled up is paid for again on each turn. Once a task is committed, its back-and-forth rarely helps the next one: /clear starts small and costs nothing, and the commit and its message already record what was done. /compact instead if the next task builds on this one. The band shows "next /clear" or "next /compact" whenever carrying on is not the best move.',
  },
  handoff: {
    title: 'Hand off instead of compacting mid-plan',
    body: 'A /compact summary is written by the model in one pass and keeps what it judges important; mid-plan that often loses the exact steps left, the files involved and why decisions were made. A handoff written on purpose (the goal, what is done, the open steps in order, files touched, decisions, the next step) keeps all of that on disk. /clear afterwards, then tell the new session to resume from the file: it starts small and reads only what the next step needs.',
  },
  'plan-ready': {
    title: 'Start fresh once the plan is written',
    body: 'Exploring and planning fill the context with files read, options weighed and questions asked. Once the plan is on disk, that history is dead weight: every request re-reads it and it competes for attention with the plan itself. /clear and ask Claude to implement the plan file: the new session reads the plan with clean context.',
  },
  corrections: {
    title: 'Start over after two failed corrections',
    body: 'Each failed attempt stays in the context and pulls the next try toward the same approach. After two corrections on the same issue, a fresh session with one better prompt (what you want, what did not work, what you learned) usually beats a third correction. Esc Esc rewinds to before the first attempt if you want to keep the earlier work.',
  },
  exploration: {
    title: 'Exploration filled the main context',
    body: 'Every file read and search result stays in the conversation and is re-read on each later turn. A subagent explores in its own context and hands back only a summary, so the main conversation stays small for the actual change. Ask for one ("use a subagent to find how X works"), and route it to a cheaper model with /route set sub:Explore haiku.',
  },
  'auto-handoff': {
    title: 'Handoff saved before the cache went cold',
    body: 'With auto-handoff on, when the prompt cache is about to expire while steps are still open, model-router asks Claude for a handoff while the cache is still warm. That send reads the context at the cache price, a fraction of the rewrite after expiry. The plugin saves the reply under ~/.claude/handoffs/ and never clears the session itself. /route handoffs auto off turns it off.',
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

const KIND_OF_REASON: Partial<Record<Advice['reason'], LessonKind>> = { boundary: 'strategy', 'plan-ready': 'plan-ready', corrections: 'corrections' }

/**
 * A lesson the first time advice turns into a handoff, a fresh start after a
 * commit or a plan, or starting over after corrections. The other advice is
 * taught already: a growing context by context-high, a cold cache by the
 * expiry warning and the cold-send guard.
 */
export function lessonFromAdvice(prev: Pick<Advice, 'verdict' | 'reason'> | undefined, a: Advice): LessonDraft | undefined {
  const isNew = a.verdict === 'handoff' ? prev?.verdict !== 'handoff' : a.reason !== prev?.reason
  const kind = a.verdict === 'handoff' ? 'handoff' : KIND_OF_REASON[a.reason]
  return isNew && kind !== undefined ? { kind, usd: a.perRequestUsd, fact: a.text } : undefined
}

export function lessonFromExploration(explored: number, total: number): LessonDraft {
  return {
    kind: 'exploration',
    fact: `File reads and searches put ${kTokens(explored)} tokens (${pct(explored / total)}) into the main context this session. A subagent reads in its own context and hands back a summary.`,
  }
}

type AutoHandoffFacts = { spentUsd: number; avoidedUsd: number; tokens: number; path: string }

export function lessonFromAutoHandoff({ spentUsd, avoidedUsd, tokens, path }: AutoHandoffFacts): LessonDraft {
  const off = '/route handoffs auto off turns this off.'
  if (avoidedUsd <= 0) return { kind: 'auto-handoff', fact: `Saved a handoff to ${path} before the cache went cold. ${off}` }
  return {
    kind: 'auto-handoff',
    usd: Math.round(Math.max(0, avoidedUsd - spentUsd) * 100) / 100,
    fact: `Saved a handoff to ${path} for ${money(spentUsd)} before the cache went cold. Resending ${kTokens(tokens)} tokens cold would have cost ${money(avoidedUsd)}. ${off}`,
  }
}

export function lessonFromCompact(beforeTokens: number): LessonDraft {
  const from = beforeTokens > 0 ? ` from about ${kTokens(beforeTokens)} tokens` : ''
  return {
    kind: 'compacted',
    fact: `The conversation was compacted${from} down to a summary. Turns now re-read far less, but details the summary left out are gone.`,
  }
}

/** The one fresh lesson worth a card: costliest first, skipping kinds shown enough or within the cooldown. */
export function pickLesson(fresh: readonly Lesson[], earlier: readonly Lesson[], now: number): Lesson | undefined {
  const due = fresh.filter(one => {
    const before = earlier.filter(e => e.kind === one.kind)
    const toasted = before.filter(e => e.isToasted)
    const lastToast = Math.max(-Infinity, ...toasted.map(e => e.at))
    return toasted.length < SEEN_ENOUGH && now - lastToast >= TOAST_COOLDOWN_MS
  })
  return [...due].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0]
}

export function cardOf(pick: Lesson, earlier: readonly Lesson[], freshCount: number): LearnCard {
  const isFirst = !earlier.some(e => e.kind === pick.kind && e.isToasted)
  return { kind: pick.kind, fact: pick.fact, isFirst, more: Math.max(0, freshCount - 1) }
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
  return typeof x === 'object' && x !== null && isLessonKind(x.kind) && typeof x.at === 'number' && typeof x.repo === 'string' && typeof x.fact === 'string' && (x.sessionId === undefined || typeof x.sessionId === 'string')
}

export const sanitizeLessons = (stored: unknown): Lesson[] =>
  Array.isArray(stored) ? capLessons(stored.filter(isLesson)).map(one => ({ ...one, repo: printable(one.repo), fact: printable(one.fact) })) : []

const NOTE_TOKENS = 1_000
const SUMMARY_TOKENS = 4_000

export type AwayFacts = { tokens: number; model: string; ttlMinutes: number; warmMinutes: number }

export type AwayRow = { name: string; now: string; back: string; how: string }

/** One way to step away per row; none when the cache is cold or the model has no prices, which `header` and `notes` then explain. */
export type Away = { header: string; rows: readonly AwayRow[]; notes: readonly string[] }

/** The ways to step away from a session, priced for its context, routed model and cache state. */
export function awayOptions(f: AwayFacts): Away {
  const key = modelKeyOf(f.model)
  if (key === undefined) {
    return { header: `No prices for ${f.model}. Before a long break: have Claude write the work in progress to a note, /rename, then /clear; or /compact while the cache is warm.`, rows: [], notes: [] }
  }
  const out = (tokens: number) => (tokens * MODELS[key].output) / 1e6
  const { write, warm } = rewritePrice(f.model, f.tokens, f.ttlMinutes)
  const ctx = `${kTokens(f.tokens)} tokens of context on ${labelOf(f.model)}`
  if (f.warmMinutes <= 0) {
    return {
      header: `${ctx}. The cache is already cold: anything sent now re-writes the ${kTokens(f.tokens)} tokens for ${money(write)}, so /clear (free) is the cheapest way out.`,
      rows: [],
      notes: ['To keep the work: /rename first and /resume later (Pro and Max offer to resume from a summary), or pay the rewrite once and ask Claude for a note before /clear.'],
    }
  }
  return {
    header: `${ctx}, cache warm for ${f.warmMinutes}m more (${f.ttlMinutes}-minute TTL).`,
    rows: [
      { name: 'Note + /clear', now: `now ≈ ${money(warm + out(NOTE_TOKENS))}`, back: 'on return ≈ $0.00', how: 'Ask Claude to write the work in progress to a file, /rename, /clear; start the next session from the note.' },
      {
        name: '/compact',
        now: `now ≈ ${money(warm + out(SUMMARY_TOKENS))}`,
        back: `on return ≈ ${money(rewritePrice(f.model, SUMMARY_TOKENS, f.ttlMinutes).write)}`,
        how: 'Say what to keep: /compact keep the plan, open TODOs and touched files. Only while warm: cold, it reads everything at full price.',
      },
      { name: '/rename, /resume', now: 'now   $0.00', back: 'on return: summary', how: 'On Pro and Max, /resume of a big session offers to continue from a summary.' },
      { name: 'Keep warm', now: `${money(warm * Math.ceil(60 / f.ttlMinutes))} an hour`, back: '', how: 'An idle ping before each expiry; pays off for a few hours, not overnight.' },
      { name: 'Do nothing', now: 'now   $0.00', back: `on return   ${money(write)}`, how: 'The first send re-writes the whole context.' },
    ],
    notes: [`Prices as of ${PRICES_AS_OF}, estimates; ≈ also guesses the note (${kTokens(NOTE_TOKENS)}) and summary (${kTokens(SUMMARY_TOKENS)}) sizes.`],
  }
}

/** `/route away`: `awayOptions` as a padded table. */
export function awayText(f: AwayFacts): string {
  const { header, rows, notes } = awayOptions(f)
  if (rows.length === 0) return [header, ...notes].join('\n')
  const row = (one: AwayRow) => `  ${one.name.padEnd(18)}${one.now.padEnd(16)}${one.back.padEnd(22)}${one.how}`
  return [header, '', ...rows.map(row), '', ...notes].join('\n')
}
