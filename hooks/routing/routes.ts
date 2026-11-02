import type { Effort, RouteEffort, RouteSetting, RouterConfig } from '../../types'
import { printable } from '../core/format'
import { EFFORTS, MODELS, SMALL_CONTEXT, SUB_CONTEXT, labelOf, modelKeyOf, rewritePrice } from '../core/pricing'

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

/** Where keep-warm's pings are counted: not a route anything runs on, but spend the person should see apart. */
export const KEEP_WARM = 'keep-warm'

const OWN_LABELS: Record<string, string> = { [ENGINE]: 'Engine (forks, workflows)', [KEEP_WARM]: 'Keep warm (cache pings while away)' }

export const routeLabel = (route: string) => ROUTES.find(one => one.key === route)?.label ?? OWN_LABELS[route] ?? route

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

export const isModel = (m: unknown): m is RouteSetting['model'] => m === 'inherit' || (typeof m === 'string' && Object.hasOwn(MODELS, m))

export const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

export const isEffort = (e: unknown): e is RouteEffort =>
  e === 'inherit' || e === 'auto' || (typeof e === 'string' && EFFORTS.includes(e as Effort))

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
  return `sub:${printable(e.subagentType)}`
}

/** `Opus 5.5 high`, or just the model when the effort is unset. */
export const routeText = (model: string, effort?: string) => `${labelOf(model)}${effort ? ` ${effort}` : ''}`

export const AUTO_LABELS = ['trivial', 'standard', 'hard'] as const

const CODING = /\b(implement|refactor|debug|fix|bug|test|build|migrate|rewrite|code|function|class|compile)\b/i

export function effortForLabel(label: string | undefined, text: string): Effort {
  if (label === 'trivial') return 'low'
  if (label === 'hard') return CODING.test(text) ? 'xhigh' : 'high'
  return 'medium'
}

// Rough output tokens a main turn spends per effort level; only used to weigh a downgrade.
const TURN_OUTPUT: Record<Effort, number> = { low: 1500, medium: 4000, high: 9000, xhigh: 16000, max: 30000 }

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
