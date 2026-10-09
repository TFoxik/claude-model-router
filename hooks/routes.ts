import type {
  Effort,
  Rewrite,
  ModelKey,
  RouteEffort,
  RouteSetting,
  RouteSpend,
  RouterConfig,
} from '../types'

export const PRICES_AS_OF = '2026-10-06'

type ModelInfo = {
  id: string
  label: string
  input: number
  output: number
  cacheRead: number
}

// USD per million tokens. Cache writes are priced from input by TTL: see writePrice.
export const MODELS: Record<ModelKey, ModelInfo> = {
  fable: { id: 'claude-fable-5-1', label: 'Fable 5.1', input: 10, output: 50, cacheRead: 0.25 },
  opus: { id: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2 },
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.2 },
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01 },
}

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type RouteRow = { key: string; label: string; parent?: string; canAuto: boolean }

export const ROUTES: readonly RouteRow[] = [
  { key: 'main', label: 'Normal work', canAuto: true },
  { key: 'plan', label: 'Plan mode', parent: 'main', canAuto: true },
  { key: 'sub:*', label: 'Subagents (default)', canAuto: false },
  { key: 'sub:Explore', label: 'Explore agent', parent: 'sub:*', canAuto: false },
  { key: 'sub:Plan', label: 'Plan agent', parent: 'sub:*', canAuto: false },
  { key: 'sub:general-purpose', label: 'General-purpose agent', parent: 'sub:*', canAuto: false },
  { key: 'workflow', label: 'Workflow agents', parent: 'sub:*', canAuto: false },
  { key: 'teammate', label: 'Teammates', parent: 'sub:*', canAuto: false },
]

export const FORK = 'fork'

const r = (model: RouteSetting['model'], effort: RouteEffort): RouteSetting => ({ model, effort })

export const PRESETS: Record<string, { label: string; routes: Record<string, RouteSetting> }> = {
  mine: {
    label: 'Mine',
    routes: {
      main: r('opus', 'medium'),
      plan: r('opus', 'high'),
      'sub:*': r('sonnet', 'high'),
    },
  },
  balanced: {
    label: 'Balanced (auto)',
    routes: {
      main: r('opus', 'auto'),
      plan: r('opus', 'high'),
      'sub:*': r('sonnet', 'medium'),
      'sub:Explore': r('haiku', 'medium'),
      'sub:Plan': r('opus', 'high'),
    },
  },
  frugal: {
    label: 'Frugal',
    routes: {
      main: r('sonnet', 'auto'),
      plan: r('opus', 'medium'),
      'sub:*': r('haiku', 'medium'),
      'sub:Explore': r('haiku', 'low'),
      'sub:Plan': r('sonnet', 'high'),
    },
  },
  max: {
    label: 'Max quality',
    routes: {
      main: r('opus', 'xhigh'),
      plan: r('fable', 'high'),
      'sub:*': r('opus', 'high'),
      'sub:Explore': r('sonnet', 'medium'),
      'sub:Plan': r('opus', 'xhigh'),
    },
  },
}

export const DEFAULT_CONFIG: RouterConfig = {
  isEnabled: true,
  preset: 'mine',
  routes: PRESETS.mine!.routes,
  cacheTtlMinutes: 60,
  coldGuard: 'refuse',
}

export function parentOf(route: string): string | undefined {
  const row = ROUTES.find(one => one.key === route)
  if (row) return row.parent
  return route.startsWith('sub:') ? 'sub:*' : undefined
}

export type Resolved = { model?: string; effort?: Effort | 'auto' }

/** Walks the route's fallback chain; a field left `inherit` everywhere stays undefined. */
export function resolve(config: RouterConfig, route: string): Resolved {
  if (!config.isEnabled || route === FORK) return {}
  let model: string | undefined
  let effort: Effort | 'auto' | undefined
  for (let at: string | undefined = route; at !== undefined; at = parentOf(at)) {
    const setting = config.routes[at]
    if (setting === undefined) continue
    if (model === undefined && setting.model !== 'inherit') model = MODELS[setting.model].id
    if (effort === undefined && setting.effort !== 'inherit') effort = setting.effort
    if (model !== undefined && effort !== undefined) break
  }
  return { model, effort }
}

export type SpawnFacts = {
  subagentType: string
  fork: boolean
  isTeammate?: true
  workflow?: unknown
}

export function routeForSpawn(e: SpawnFacts): string {
  if (e.fork) return FORK
  if (e.workflow !== undefined) return 'workflow'
  if (e.isTeammate) return 'teammate'
  return `sub:${e.subagentType}`
}

export function modelKeyOf(id: string): ModelKey | undefined {
  return (Object.keys(MODELS) as ModelKey[]).find(key => id.includes(key))
}

export function labelOf(id: string): string {
  const key = modelKeyOf(id)
  return key ? MODELS[key].label : id
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const DEFAULT_TTL = 60

/** Cache writes cost 2x input with the 1-hour TTL Claude Code uses, 1.25x with the 5-minute one. */
export function writePrice(p: ModelInfo, ttlMinutes = DEFAULT_TTL): number {
  return p.input * (ttlMinutes >= 60 ? 2 : 1.25)
}

export function costOf(usage: Usage, modelId: string, ttlMinutes = DEFAULT_TTL): number {
  const key = modelKeyOf(modelId)
  if (key === undefined) return 0
  const p = MODELS[key]
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_read_input_tokens * p.cacheRead +
      usage.cache_creation_input_tokens * writePrice(p, ttlMinutes)) /
    1e6
  )
}

export const ttlOf = (config: RouterConfig) => config.cacheTtlMinutes ?? DEFAULT_TTL

/** How long ago the cache expired; negative while it is still warm. */
export const coldForMs = (lastAt: number, now: number, ttlMinutes: number) => now - lastAt - ttlMinutes * 60_000

/** Writing `tokens` to the cache, reading them warm instead, and the premium the write pays over the read. */
export function rewritePrice(modelId: string, tokens: number, ttlMinutes = DEFAULT_TTL): { write: number; warm: number; premium: number } {
  const key = modelKeyOf(modelId)
  if (key === undefined) return { write: 0, warm: 0, premium: 0 }
  const p = MODELS[key]
  const write = (tokens * writePrice(p, ttlMinutes)) / 1e6
  const warm = (tokens * p.cacheRead) / 1e6
  return { write, warm, premium: write - warm }
}

/** Below this the rewrite costs cents, so the guard stays out of the way. */
export const GUARD_MIN_TOKENS = 50_000

export type RewriteFacts = {
  isAfterCompact: boolean
  prevAt?: number
  now: number
  ttlMinutes: number
  from?: { model: string; effort?: Effort }
  to: { model: string; effort?: Effort }
}

/** Why a main-loop request would rebuild the cache; compaction rebuilds it anyway, so that one is not counted. */
export function rewriteCause(f: RewriteFacts): Rewrite['cause'] | undefined {
  if (f.isAfterCompact) return undefined
  if (f.prevAt !== undefined && coldForMs(f.prevAt, f.now, f.ttlMinutes) >= 0) return 'cold'
  if (f.from !== undefined && (f.from.model !== f.to.model || f.from.effort !== f.to.effort)) return 'switch'
  return undefined
}

/**
 * With a cause, a request that wrote most of a sizeable prompt rebuilt the
 * cache; without one the write is just new content, such as a big file read.
 */
export function rewriteOf(usage: Usage, modelId: string, cause: Rewrite['cause'] | undefined, ttlMinutes = DEFAULT_TTL): Rewrite | undefined {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const write = usage.cache_creation_input_tokens
  if (cause === undefined || prompt <= 20_000 || write < 0.5 * prompt || modelKeyOf(modelId) === undefined) return undefined
  return { cause, tokens: write, usd: rewritePrice(modelId, write, ttlMinutes).premium }
}

export function fmtAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  return h > 0 ? `${h}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

export const EMPTY_SPEND: RouteSpend = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 }

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

export const AUTO_LABELS = ['trivial', 'standard', 'hard'] as const

const CODING = /\b(implement|refactor|debug|fix|bug|test|build|migrate|rewrite|code|function|class|compile)\b/i

export function effortForLabel(label: string | undefined, text: string): Effort {
  if (label === 'trivial') return 'low'
  if (label === 'hard') return CODING.test(text) ? 'xhigh' : 'high'
  return 'medium'
}

// Rough output tokens a main turn spends per effort level; only used to weigh a downgrade.
export const TURN_OUTPUT: Record<Effort, number> = { low: 1500, medium: 4000, high: 9000, xhigh: 16000, max: 30000 }

export const SMALL_CONTEXT = 20_000

export type SwitchFacts = {
  contextTokens: number
  isAfterCompact: boolean
  from: { model: string; effort?: Effort }
  to: { model: string; effort?: Effort }
  ttlMinutes?: number
}

/**
 * A model or effort change on the main loop re-writes the whole context to the
 * prompt cache. Upgrades always go through (quality first); a downgrade only
 * when the context is small, the cache just restarted, or it pays for itself.
 */
export function shouldSwitch(f: SwitchFacts): boolean {
  if (f.from.model === f.to.model && f.from.effort === f.to.effort) return true
  if (f.isAfterCompact || f.contextTokens < SMALL_CONTEXT) return true
  const fromKey = modelKeyOf(f.from.model)
  const toKey = modelKeyOf(f.to.model)
  if (fromKey === undefined || toKey === undefined) return true
  const from = MODELS[fromKey]
  const to = MODELS[toKey]
  const fromOut = TURN_OUTPUT[f.from.effort ?? 'medium'] * from.output
  const toOut = TURN_OUTPUT[f.to.effort ?? 'medium'] * to.output
  if (toOut >= fromOut) return true
  const saving = (fromOut - toOut) / 1e6
  return saving > rewritePrice(f.to.model, f.contextTokens, f.ttlMinutes).premium
}

export function parseSetting(model: string | undefined, effort: string | undefined): RouteSetting | string {
  const m = (model ?? '').toLowerCase()
  const e = (effort ?? 'inherit').toLowerCase()
  const isModel = m === 'inherit' || m in MODELS
  if (!isModel) return `Unknown model "${model}". Use ${Object.keys(MODELS).join(', ')} or inherit.`
  if (e !== 'inherit' && e !== 'auto' && !EFFORTS.includes(e as Effort))
    return `Unknown effort "${effort}". Use ${EFFORTS.join(', ')}, auto or inherit.`
  return { model: m as RouteSetting['model'], effort: e as RouteEffort }
}

/**
 * Colour for context use, measured against where auto-compaction fires when
 * known (else the whole window): green below 60%, amber to 85%, red after.
 */
export function contextLevel(tokens: number, window: number, compactAt?: number): 'success' | 'warning' | 'error' {
  const toward = tokens / (compactAt && compactAt > 0 ? compactAt : window)
  return toward >= 0.85 ? 'error' : toward >= 0.6 ? 'warning' : 'success'
}

export type StatsRecord = { at: number; repo: string; label: string; text: string; usd: number; requests: number; agents: number; models?: Record<string, number> }

export const HISTORY_LIMIT = 2000

export function commandLabel(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? ''
  return first.startsWith('/') && first.length > 1 ? first : 'prompt'
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

export type CommandStats = { label: string; runs: number; total: number; avg: number; max: number; models: Record<string, number> }

export function commandStats(records: readonly StatsRecord[]): CommandStats[] {
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

export function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export const SUB_CONTEXT = 30_000

export type ChangeRow = {
  route: string
  from: string
  to: string
  /** One-off cache rewrite the change causes now; 0 where the loop has no warm cache. */
  switchCost: number
  /** Rough change in cost per turn (main, plan) or per subagent run. */
  perTurnDelta: number
}

function describe(r: Resolved): string {
  return `${r.model ? labelOf(r.model) : 'inherit'} · ${r.effort ?? 'inherit'}`
}

function turnCost(r: Resolved, fallbackModel: string, context: number): number {
  const key = modelKeyOf(r.model ?? fallbackModel)
  if (key === undefined) return 0
  const effort = r.effort === undefined || r.effort === 'auto' ? 'medium' : r.effort
  const p = MODELS[key]
  return (TURN_OUTPUT[effort] * p.output + context * p.cacheRead) / 1e6
}

function rewriteCost(r: Resolved, fallbackModel: string, context: number, ttlMinutes: number): number {
  return rewritePrice(r.model ?? fallbackModel, context, ttlMinutes).premium
}

const same = (a: Resolved, b: Resolved) => a.model === b.model && a.effort === b.effort

/**
 * What applying `next` over `current` would change, route by route. Only the
 * route the main loop is on right now (`liveRoute`) pays a cache rewrite at
 * once; subagents start fresh, so a change there costs nothing up front.
 */
export function estimateChanges(
  current: RouterConfig,
  next: RouterConfig,
  facts: { contextTokens: number; liveRoute: 'main' | 'plan'; sessionModel: string; ttlMinutes?: number },
): ChangeRow[] {
  const rows: ChangeRow[] = []
  for (const { key } of ROUTES) {
    const a = resolve(current, key)
    const b = resolve(next, key)
    if (same(a, b)) continue
    const isMain = key === 'main' || key === 'plan'
    const context = isMain ? facts.contextTokens : SUB_CONTEXT
    rows.push({
      route: key,
      from: describe(a),
      to: describe(b),
      switchCost: key === facts.liveRoute ? rewriteCost(b, facts.sessionModel, facts.contextTokens, facts.ttlMinutes ?? DEFAULT_TTL) : 0,
      perTurnDelta: turnCost(b, facts.sessionModel, context) - turnCost(a, facts.sessionModel, context),
    })
  }
  return rows
}

/** Each plan-mode toggle rewrites the cache when plan and main differ. */
export function modeSwitchCost(config: RouterConfig, contextTokens: number, sessionModel: string): number {
  const plan = resolve(config, 'plan')
  const main = resolve(config, 'main')
  return same(plan, main) ? 0 : rewriteCost(plan, sessionModel, contextTokens, ttlOf(config))
}
