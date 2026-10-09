import type {
  ColdGuard,
  Effort,
  PromptCost,
  PromptItem,
  PromptRecord,
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

type RouteRow = { key: string; label: string; parent?: string }

/** In pane order: the main loop first, then the subagent default and its overrides. */
export const ROUTES: readonly RouteRow[] = [
  { key: 'plan', label: 'Plan mode', parent: 'main' },
  { key: 'main', label: 'Normal work' },
  { key: 'sub:*', label: 'Default' },
  { key: 'sub:Explore', label: 'Explore', parent: 'sub:*' },
  { key: 'sub:Plan', label: 'Plan agent', parent: 'sub:*' },
  { key: 'sub:general-purpose', label: 'General', parent: 'sub:*' },
  { key: 'workflow', label: 'Workflow', parent: 'sub:*' },
  { key: 'teammate', label: 'Teammates', parent: 'sub:*' },
]

/** The main loop's routes: only these carry a cache across turns, so only they take `auto`. */
export const isLoopRoute = (route: string) => route === 'main' || route === 'plan'

/** Where the steps of agents the router can't place are counted: a workflow's before its spawn settles, the engine's own forks. */
export const ENGINE = 'engine'

export const routeLabel = (route: string) => ROUTES.find(one => one.key === route)?.label ?? (route === ENGINE ? 'Engine (forks, workflows)' : route)

/** A route `/route set` may write: a known one, or `sub:<agent-type>`. */
export const isRouteKey = (route: string) => ROUTES.some(one => one.key === route) || /^sub:[\w.:-]{1,64}$/.test(route)

export const FORK = 'fork'

const r = (model: RouteSetting['model'], effort: RouteEffort): RouteSetting => ({ model, effort })

export const PRESETS: Record<string, { label: string; routes: Record<string, RouteSetting> }> = {
  inherit: {
    label: 'Inherit (track only)',
    routes: {},
  },
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

/** A fresh install changes no model until a preset is picked; costs, the band and the guard still work. */
export const DEFAULT_CONFIG: RouterConfig = {
  isEnabled: true,
  preset: 'inherit',
  routes: {},
  cacheTtlMinutes: 60,
  coldGuard: 'refuse',
  keepPromptText: true,
  isLearning: false,
}

/**
 * The config to start from when the store holds none. An install that already
 * kept history predates the inherit default and never saved a config, so it
 * keeps the routing it ran with: the `mine` preset.
 */
export function startingConfig(stored: unknown, hasHistory: boolean): RouterConfig {
  if (stored !== undefined) return sanitizeConfig(stored)
  return hasHistory ? withPreset(DEFAULT_CONFIG, 'mine')! : DEFAULT_CONFIG
}

export const presetOf = (name: string) => (Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined)

/** The config with a preset's routes; undefined for a name that is not a preset. */
export function withPreset(config: RouterConfig, name: string): RouterConfig | undefined {
  const preset = presetOf(name)
  return preset && { ...config, preset: name, routes: { ...preset.routes } }
}

/** The config with one route set, which makes it a custom preset. */
export const withRoute = (config: RouterConfig, route: string, setting: RouteSetting): RouterConfig => ({
  ...config,
  preset: 'custom',
  routes: { ...config.routes, [route]: setting },
})

const isModel = (m: unknown): m is RouteSetting['model'] => m === 'inherit' || (typeof m === 'string' && Object.hasOwn(MODELS, m))
const isEffort = (e: unknown): e is RouteEffort =>
  e === 'inherit' || e === 'auto' || (typeof e === 'string' && EFFORTS.includes(e as Effort))
const GUARDS: readonly ColdGuard[] = ['refuse', 'warn', 'off']

/**
 * The stored config, keeping only what this version understands; a route the
 * engine would reject (an unknown model or effort) is dropped, not sent.
 */
export function sanitizeConfig(stored: unknown): RouterConfig {
  if (typeof stored !== 'object' || stored === null) return DEFAULT_CONFIG
  const s = stored as Partial<Record<keyof RouterConfig, unknown>>
  const routes: Record<string, RouteSetting> = {}
  if (typeof s.routes === 'object' && s.routes !== null) {
    for (const [key, one] of Object.entries(s.routes)) {
      const setting = one as Partial<RouteSetting> | null
      if (isRouteKey(key) && isModel(setting?.model) && isEffort(setting?.effort)) routes[key] = { model: setting.model, effort: setting.effort }
    }
  }
  return {
    isEnabled: typeof s.isEnabled === 'boolean' ? s.isEnabled : DEFAULT_CONFIG.isEnabled,
    preset: typeof s.preset === 'string' ? s.preset : DEFAULT_CONFIG.preset,
    routes,
    cacheTtlMinutes: s.cacheTtlMinutes === 5 || s.cacheTtlMinutes === 60 ? s.cacheTtlMinutes : DEFAULT_CONFIG.cacheTtlMinutes,
    coldGuard: GUARDS.includes(s.coldGuard as ColdGuard) ? (s.coldGuard as ColdGuard) : DEFAULT_CONFIG.coldGuard,
    keepPromptText: typeof s.keepPromptText === 'boolean' ? s.keepPromptText : DEFAULT_CONFIG.keepPromptText,
    isLearning: typeof s.isLearning === 'boolean' ? s.isLearning : DEFAULT_CONFIG.isLearning,
  }
}

const isRecord = (r: unknown): r is PromptRecord => {
  const x = r as PromptRecord | null
  return typeof x === 'object' && x !== null && typeof x.at === 'number' && typeof x.repo === 'string' && typeof x.label === 'string' &&
    typeof x.text === 'string' && typeof x.usd === 'number' && typeof x.requests === 'number' && typeof x.agents === 'number'
}

export const sanitizeHistory = (stored: unknown): PromptRecord[] => (Array.isArray(stored) ? stored.filter(isRecord).slice(-HISTORY_LIMIT) : [])

/** Terminal control characters stripped from text the panes show but didn't write. */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')

function parentOf(route: string): string | undefined {
  const row = ROUTES.find(one => one.key === route)
  if (row) return row.parent
  return route.startsWith('sub:') ? 'sub:*' : undefined
}

type Resolved = { model?: string; effort?: Effort | 'auto' }

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

type SpawnFacts = {
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

/** `Opus` for `Opus 5.5`: the label without its version. */
export const shortLabel = (label: string) => label.replace(/ [\d.]+$/, '')

/** `Opus 5.5 high`, or just the model when the effort is unset. */
export const routeText = (model: string, effort?: string) => `${labelOf(model)}${effort ? ` ${effort}` : ''}`

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const DEFAULT_TTL = 60

/** Cache writes cost 2x input with the 1-hour TTL Claude Code uses, 1.25x with the 5-minute one. */
function writePrice(p: ModelInfo, ttlMinutes = DEFAULT_TTL): number {
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

/** How long ago the cache expired; negative while it is still warm. */
export const coldForMs = (lastAt: number, now: number, ttlMinutes: number) => now - lastAt - ttlMinutes * 60_000

/** Whole minutes the cache stays warm, 0 once cold. */
export const warmMinutesLeft = (lastAt: number, now: number, ttlMinutes: number) => Math.max(0, Math.ceil(-coldForMs(lastAt, now, ttlMinutes) / 60_000))

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

type RewriteFacts = {
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

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const sumUsd = (xs: readonly { usd: number }[]) => xs.reduce((acc, one) => acc + one.usd, 0)

export const AUTO_LABELS = ['trivial', 'standard', 'hard'] as const

const CODING = /\b(implement|refactor|debug|fix|bug|test|build|migrate|rewrite|code|function|class|compile)\b/i

export function effortForLabel(label: string | undefined, text: string): Effort {
  if (label === 'trivial') return 'low'
  if (label === 'hard') return CODING.test(text) ? 'xhigh' : 'high'
  return 'medium'
}

// Rough output tokens a main turn spends per effort level; only used to weigh a downgrade.
const TURN_OUTPUT: Record<Effort, number> = { low: 1500, medium: 4000, high: 9000, xhigh: 16000, max: 30000 }

export const SMALL_CONTEXT = 20_000

type SwitchFacts = {
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

export function parseSetting(route: string, model: string | undefined, effort: string | undefined): RouteSetting | string {
  const m = (model ?? '').toLowerCase()
  const e = (effort ?? 'inherit').toLowerCase()
  if (!isRouteKey(route)) return `Unknown route "${route}". Use ${ROUTES.map(one => one.key).join(', ')}, or sub:<agent-type>.`
  if (!isModel(m)) return `Unknown model "${model}". Use ${Object.keys(MODELS).join(', ')} or inherit.`
  if (!isEffort(e)) return `Unknown effort "${effort}". Use ${EFFORTS.join(', ')}, auto or inherit.`
  if (e === 'auto' && !isLoopRoute(route)) return 'auto effort is for main and plan only; subagents start fresh, so pick a level.'
  return { model: m, effort: e }
}

/**
 * Colour for context use, measured against where auto-compaction fires when
 * known (else the whole window): green below 60%, amber to 85%, red after.
 */
export function contextLevel(tokens: number, window: number, compactAt?: number): 'success' | 'warning' | 'error' {
  const toward = tokens / (compactAt && compactAt > 0 ? compactAt : window)
  return toward >= 0.85 ? 'error' : toward >= 0.6 ? 'warning' : 'success'
}

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

export const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

export const SUB_CONTEXT = 30_000

type ChangeRow = {
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
  facts: DraftFacts,
): ChangeRow[] {
  const rows: ChangeRow[] = []
  for (const { key } of ROUTES) {
    const a = resolve(current, key)
    const b = resolve(next, key)
    if (same(a, b)) continue
    const context = isLoopRoute(key) ? facts.contextTokens : SUB_CONTEXT
    rows.push({
      route: key,
      from: describe(a),
      to: describe(b),
      switchCost: key === facts.liveRoute ? rewriteCost(b, facts.sessionModel, facts.contextTokens, facts.ttlMinutes) : 0,
      perTurnDelta: turnCost(b, facts.sessionModel, context) - turnCost(a, facts.sessionModel, context),
    })
  }
  return rows
}

type DraftFacts = { contextTokens: number; liveRoute: 'main' | 'plan'; sessionModel: string; ttlMinutes: number }

/** What applying `pending` would cost: per-route changes, the cache rewrite now, the plan toggle before and after, and the payback in turns. */
export function draftSummary(current: RouterConfig, pending: RouterConfig | null, facts: DraftFacts) {
  const changes = pending ? estimateChanges(current, pending, facts) : []
  const upFront = changes.reduce((sum, one) => sum + one.switchCost, 0)
  const toggleNow = modeSwitchCost(current, facts.contextTokens, facts.sessionModel)
  const toggleAfter = pending ? modeSwitchCost(pending, facts.contextTokens, facts.sessionModel) : toggleNow
  const livePerTurn = changes.filter(one => one.route === facts.liveRoute).reduce((sum, one) => sum + one.perTurnDelta, 0)
  const payback = upFront > 0 && livePerTurn < 0 ? Math.ceil(upFront / -livePerTurn) : undefined
  return { changes, upFront, toggleNow, toggleAfter, payback }
}

/** Each plan-mode toggle rewrites the cache when plan and main differ. */
export function modeSwitchCost(config: RouterConfig, contextTokens: number, sessionModel: string): number {
  const plan = resolve(config, 'plan')
  const main = resolve(config, 'main')
  return same(plan, main) ? 0 : rewriteCost(plan, sessionModel, contextTokens, config.cacheTtlMinutes)
}
