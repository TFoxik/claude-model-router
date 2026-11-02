import type { RouterConfig } from '../../types'
import { WARM_HOURS } from '../core/config'
import { KEEP_WARM_TTL } from '../core/pricing'

/** One word back keeps the fork's output, and its price, near zero. */
export const WARM_PROMPT = 'Reply with OK.'

/** Early enough to land before the expiry lesson's (5) and auto-handoff's (3) last minutes on the 60-minute cache. */
export const PING_AT_MINUTES = 6

export const FORK_TIMEOUT_MS = 2 * 60_000

/** Why keep-warm can't help now, or undefined when it can. */
export function warmBlock(cfg: RouterConfig, warmMinutes: number): 'off' | 'ttl' | 'cold' | undefined {
  return !cfg.isContext ? 'off' : cfg.cacheTtlMinutes !== KEEP_WARM_TTL ? 'ttl' : warmMinutes === 0 ? 'cold' : undefined
}

/** `2h` or `2` as a ceiling within the picker's range. */
export function parseWarmHours(word: string): number | undefined {
  const hours = Number(word.replace(/h$/, ''))
  return Number.isInteger(hours) && hours >= 1 && hours <= Math.max(...WARM_HOURS) ? hours : undefined
}
