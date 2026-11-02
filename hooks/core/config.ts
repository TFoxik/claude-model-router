import type { ColdGuard, LessonKind, RouteSetting, RouterConfig } from '../../types'
import { isEffort, isModel, isRouteKey, withPreset } from '../routing/routes'

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
  autoHandoff: false,
  showNext: true,
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

export const GUARDS: readonly ColdGuard[] = ['refuse', 'warn', 'off']

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
    autoHandoff: typeof s.autoHandoff === 'boolean' ? s.autoHandoff : DEFAULT_CONFIG.autoHandoff,
    showNext: typeof s.showNext === 'boolean' ? s.showNext : DEFAULT_CONFIG.showNext,
  }
}
