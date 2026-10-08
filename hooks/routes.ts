import type {
  Effort,
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
    label: 'Mine (plan Opus high, subagents Sonnet high)',
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
  const switchCost = (f.contextTokens * (writePrice(to, f.ttlMinutes) - to.cacheRead)) / 1e6
  return saving > switchCost
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
  const key = modelKeyOf(r.model ?? fallbackModel)
  if (key === undefined) return 0
  const p = MODELS[key]
  return (context * (writePrice(p, ttlMinutes) - p.cacheRead)) / 1e6
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
  return same(plan, main) ? 0 : rewriteCost(plan, sessionModel, contextTokens, config.cacheTtlMinutes ?? DEFAULT_TTL)
}
