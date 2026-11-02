import type { WarmHours, WarmRun } from '../../types'
import { WARM_HOURS } from '../core/config'

/** One word back keeps the fork's output, and its price, near zero. */
export const WARM_PROMPT = 'Reply with OK.'

/** Early enough to land before the expiry lesson's (5) and auto-handoff's (3) last minutes on the 60-minute cache. */
export const PING_AT_MINUTES = 6

export function shouldPing(run: WarmRun | null, warmMinutes: number, now: number): boolean {
  return run !== null && now < run.until && warmMinutes > 0 && warmMinutes <= PING_AT_MINUTES
}

/** `2h` or `2` as a ceiling within the picker's range; no word is the setting. */
export function parseWarmHours(word: string | undefined, fallback: WarmHours): number | 'invalid' {
  if (word === undefined) return fallback
  const hours = Number(word.replace(/h$/, ''))
  return Number.isInteger(hours) && hours >= 1 && hours <= Math.max(...WARM_HOURS) ? hours : 'invalid'
}
