import type { ColdGuard, LessonKind, LevelBand, LevelKind, Levels, RouteSetting, RouterConfig, WarmHours } from '../../types'
import { isEffort, isModel, isRouteKey, withPreset } from '../routing/routes'
import { CONTEXT_CRITICAL, CONTEXT_WARN, bandLevel } from './pricing'
import type { Level } from './pricing'

/** A fresh install changes no model until a preset is picked; costs, the band and the guard still work. */
export const DEFAULT_CONFIG: RouterConfig = {
  isEnabled: true,
  preset: 'inherit',
  routes: {},
  cacheTtlMinutes: 60,
  coldGuard: 'refuse',
  keepPromptText: true,
  isLearning: false,
  learnMuted: [],
  isHandoffs: true,
  isCost: true,
  isContext: true,
  autoHandoff: false,
  showNext: true,
  warmHours: 4,
  autoWarm: false,
  levels: {
    cache: { warn: 80, bad: 50 },
    context: { warn: CONTEXT_WARN * 100, bad: CONTEXT_CRITICAL * 100 },
    limits: { warn: 70, bad: 90 },
  },
}

export const LEVEL_KINDS: readonly LevelKind[] = ['cache', 'context', 'limits']

export const isHighGood = (kind: LevelKind) => kind === 'cache'

/** A usable pair: whole percents from 1 to 100, ordered so amber comes before red. */
export function isLevelBand(kind: LevelKind, band: unknown): band is LevelBand {
  if (typeof band !== 'object' || band === null) return false
  const { warn, bad } = band as Partial<LevelBand>
  const isPct = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 100
  if (!isPct(warn) || !isPct(bad)) return false
  return isHighGood(kind) ? warn > bad : warn < bad
}

export const levelOf = (kind: LevelKind, pct: number, levels: Levels): Level => bandLevel(pct, levels[kind], isHighGood(kind))

export const levelText = (kind: LevelKind, { warn, bad }: LevelBand) =>
  isHighGood(kind) ? `amber below ${warn}%, red below ${bad}%` : `amber from ${warn}%, red from ${bad}%`

function sanitizeLevels(stored: unknown): Levels {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<Record<LevelKind, unknown>>
  const out = { ...DEFAULT_CONFIG.levels }
  for (const kind of LEVEL_KINDS) if (isLevelBand(kind, s[kind])) out[kind] = { warn: s[kind].warn, bad: s[kind].bad }
  return out
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

export type Feature = 'routing' | 'context' | 'cost' | 'handoffs' | 'learn'

type FeatureRow = {
  key: Feature
  field: 'isEnabled' | 'isContext' | 'isCost' | 'isHandoffs' | 'isLearning'
  title: string
  line: string
  on: string
  off: string
}

/** Every switchable feature, in the order `/route features` lists them: its switch in the config, what it does, and what switching it says. */
export const FEATURES: readonly FeatureRow[] = [
  { key: 'routing', field: 'isEnabled', title: 'Routing', line: 'models and effort per kind of work', on: 'Model router enabled.', off: 'Model router disabled.' },
  {
    key: 'context',
    field: 'isContext',
    title: 'Context',
    line: 'cache and context in the band, cold-send guard, next-step advice',
    on: 'Context on.',
    off: 'Context off: no Context pane, cold-send guard, next-step advice or band cache and context; measuring keeps running.',
  },
  {
    key: 'cost',
    field: 'isCost',
    title: 'Cost',
    line: 'what each prompt costs: the Cost pane, the footer and the band',
    on: 'Cost on.',
    off: 'Cost off: no Cost pane, footer or band money; history keeps recording (/route stats clear deletes it).',
  },
  {
    key: 'handoffs',
    field: 'isHandoffs',
    title: 'Handoffs',
    line: 'notes to resume work in a fresh session',
    on: 'Handoffs on: the band counts handoffs other sessions left open, and auto-handoff runs when it is on (/route handoffs auto on|off).',
    off: 'Handoffs off: no count in the band and no auto-handoff. Handoffs you save with /handoff are still listed in /route handoffs.',
  },
  {
    key: 'learn',
    field: 'isLearning',
    title: 'Learn',
    line: 'cards that explain what a cache miss or a model cost you',
    on: 'Learn mode on: when a cache rewrite, a pricey model, a growing context or busy subagents cost you, a card above the band explains it with the numbers, until your next prompt.',
    off: 'Learn mode off.',
  },
]

export const featureOf = (key: string): FeatureRow | undefined => FEATURES.find(one => one.key === key)

export const offText = (f: Feature): string => `${featureOf(f)!.title} is off. /route ${f} on turns it on.`

export const isFeatureOn = (cfg: RouterConfig, f: Feature): boolean => cfg[featureOf(f)!.field]

export const GUARDS: readonly ColdGuard[] = ['refuse', 'warn', 'off']

export const WARM_HOURS: readonly WarmHours[] = [1, 2, 4, 6]

/** The prompt-cache lifetimes the API offers, in minutes. */
export const CACHE_TTLS: readonly number[] = [60, 5]

const LESSON_KINDS: Record<LessonKind, true> = {
  'cold-rewrite': true,
  'switch-rewrite': true,
  'pricey-model': true,
  'context-high': true,
  compacted: true,
  subagents: true,
  'cache-expiring': true,
  'plan-toggle': true,
  strategy: true,
  handoff: true,
  'plan-ready': true,
  corrections: true,
  exploration: true,
  'auto-handoff': true,
}

export const isLessonKind = (kind: unknown): kind is LessonKind => typeof kind === 'string' && Object.hasOwn(LESSON_KINDS, kind)

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
    learnMuted: Array.isArray(s.learnMuted) ? [...new Set(s.learnMuted.filter(isLessonKind))] : DEFAULT_CONFIG.learnMuted,
    isHandoffs: typeof s.isHandoffs === 'boolean' ? s.isHandoffs : DEFAULT_CONFIG.isHandoffs,
    isCost: typeof s.isCost === 'boolean' ? s.isCost : DEFAULT_CONFIG.isCost,
    isContext: typeof s.isContext === 'boolean' ? s.isContext : DEFAULT_CONFIG.isContext,
    autoHandoff: typeof s.autoHandoff === 'boolean' ? s.autoHandoff : DEFAULT_CONFIG.autoHandoff,
    showNext: typeof s.showNext === 'boolean' ? s.showNext : DEFAULT_CONFIG.showNext,
    warmHours: WARM_HOURS.includes(s.warmHours as WarmHours) ? (s.warmHours as WarmHours) : DEFAULT_CONFIG.warmHours,
    autoWarm: typeof s.autoWarm === 'boolean' ? s.autoWarm : DEFAULT_CONFIG.autoWarm,
    levels: sanitizeLevels(s.levels),
  }
}
