import type { Effort, PromptCost, PromptItem, PromptRecord, Rewrite, RouteSpend } from '../../types'
import { printable, sameDay } from './format'
import { DEFAULT_TTL, costOf } from './pricing'
import type { Usage } from './pricing'
import { routeText } from '../routing/routes'

const isRecord = (r: unknown): r is PromptRecord => {
  const x = r as PromptRecord | null
  return typeof x === 'object' && x !== null && typeof x.at === 'number' && typeof x.repo === 'string' && typeof x.label === 'string' &&
    typeof x.text === 'string' && typeof x.usd === 'number' && typeof x.requests === 'number' && typeof x.agents === 'number'
}

const micro = (usd: number) => Math.round(usd * 1e6) / 1e6

/** Costs cut to the micro-dollar: summed float costs carry 17 digits, which history would store 2000 times over. */
export const compactRecord = (r: PromptRecord): PromptRecord => ({
  ...r,
  usd: micro(r.usd),
  ...(r.models ? { models: Object.fromEntries(Object.entries(r.models).map(([key, usd]) => [key, micro(usd)])) } : {}),
  ...(r.rewrites ? { rewrites: r.rewrites.map(one => ({ ...one, usd: micro(one.usd) })) } : {}),
})

/** Also cleans the names the panes show, for history saved before they were cleaned at record time. */
export const sanitizeHistory = (stored: unknown): PromptRecord[] =>
  Array.isArray(stored)
    ? stored.filter(isRecord).slice(-HISTORY_LIMIT).map(r => compactRecord({ ...r, repo: printable(r.repo), label: printable(r.label), text: printable(r.text) }))
    : []

export const EMPTY_SPEND: RouteSpend = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 }

export const EMPTY_PROMPT: PromptCost = { usd: 0, requests: 0, items: [] }

export function addSpend(spend: RouteSpend, usage: Usage, modelId: string, ttlMinutes = DEFAULT_TTL): RouteSpend {
  return {
    requests: spend.requests + 1,
    input: spend.input + usage.input_tokens,
    cacheRead: spend.cacheRead + usage.cache_read_input_tokens,
    cacheWrite: spend.cacheWrite + usage.cache_creation_input_tokens,
    output: spend.output + usage.output_tokens,
    usd: spend.usd + costOf(usage, modelId, ttlMinutes),
  }
}

type StepFacts = { id: string; route: string; label: string; effort?: Effort; usage: Usage & { model: string }; ttlMinutes: number; rewrite?: Rewrite }

/** The prompt's cost with one more request added to the item it belongs to. */
export function addStep(p: PromptCost, s: StepFacts): PromptCost {
  const at = p.items.findIndex(one => one.id === s.id)
  const old: PromptItem = at >= 0 ? p.items[at]! : { id: s.id, route: s.route, label: s.label, model: s.usage.model, ...EMPTY_SPEND }
  const item: PromptItem = {
    ...old,
    ...addSpend(old, s.usage, s.usage.model, s.ttlMinutes),
    model: s.usage.model,
    ...(s.effort ? { effort: s.effort } : {}),
    ...(old.isMixed || old.model !== s.usage.model ? { isMixed: true } : {}),
  }
  const items = at >= 0 ? p.items.with(at, item) : [...p.items, item]
  return {
    usd: p.usd + item.usd - old.usd,
    requests: p.requests + 1,
    items,
    rewrites: s.rewrite ? [...(p.rewrites ?? []), s.rewrite] : p.rewrites,
  }
}

/** A subagent's item is keyed by its agent id; the main loop's by its route. */
export const isSub = (item: PromptItem) => item.id !== item.route

/** A saved prompt with one more request from a subagent it started that outlived it. */
export function addLateStep(r: PromptRecord, s: { usage: Usage & { model: string }; effort?: Effort; ttlMinutes: number }): PromptRecord {
  const usd = costOf(s.usage, s.usage.model, s.ttlMinutes)
  const key = routeText(s.usage.model, s.effort)
  return { ...r, usd: r.usd + usd, requests: r.requests + 1, models: { ...r.models, [key]: (r.models?.[key] ?? 0) + usd } }
}

export const subagentCount = (p: PromptCost) => p.items.filter(isSub).length

export function modelsOf(p: PromptCost): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of p.items) {
    const key = routeText(item.model, item.effort)
    out[key] = (out[key] ?? 0) + item.usd
  }
  return out
}

export const sumUsd = (xs: readonly { usd: number }[]) => xs.reduce((acc, one) => acc + one.usd, 0)

export const HISTORY_LIMIT = 2000

/** The history without prompt text, for when it should not be kept. */
export const withoutText = (records: readonly PromptRecord[]): PromptRecord[] => records.map(r => ({ ...r, text: '' }))

/** What the Stats pane shows for a set of records. */
export function statsSummary(records: readonly PromptRecord[], now: number) {
  return {
    today: todayUsd(records, now),
    week: sumUsd(records.filter(r => now - r.at < 7 * 86_400_000)),
    rewrites: records.flatMap(r => r.rewrites ?? []),
    commands: commandStats(records).slice(0, 10),
    priciest: [...records].sort((x, y) => y.usd - x.usd).slice(0, 8),
  }
}

/** Today's spend; records are kept in time order, so only today's tail is read. */
export function todayUsd(records: readonly PromptRecord[], now: number): number {
  let usd = 0
  for (let i = records.length - 1; i >= 0 && sameDay(records[i]!.at, now); i--) usd += records[i]!.usd
  return usd
}

type CommandStats = { label: string; runs: number; total: number; avg: number; max: number; models: Record<string, number> }

export function commandStats(records: readonly PromptRecord[]): CommandStats[] {
  const by = new Map<string, CommandStats>()
  for (const r of records) {
    const was = by.get(r.label) ?? { label: r.label, runs: 0, total: 0, avg: 0, max: 0, models: {} }
    const runs = was.runs + 1
    const total = was.total + r.usd
    const models = { ...was.models }
    for (const [model, usd] of Object.entries(r.models ?? {})) models[model] = (models[model] ?? 0) + usd
    by.set(r.label, { label: r.label, runs, total, avg: total / runs, max: Math.max(was.max, r.usd), models })
  }
  return [...by.values()].sort((a, b) => b.avg - a.avg)
}

/** `Opus 5.5 $4.10 · Sonnet 5.5 $2.00`, most expensive first. */
export function modelMix(models: Record<string, number> | undefined, format: (usd: number) => string, limit = 3): string {
  return Object.entries(models ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([model, usd]) => `${model} ${format(usd)}`)
    .join(' · ')
}
