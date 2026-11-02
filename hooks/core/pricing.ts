import type { Effort, ModelKey, Rewrite } from '../../types'
import { printable } from './format'

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

/** The model an API id (`claude-opus-5-5`) or a display label (`Opus 5.5 high`) names. */
export function modelKeyOf(id: string): ModelKey | undefined {
  const lower = id.toLowerCase()
  return (Object.keys(MODELS) as ModelKey[]).find(key => lower.includes(key))
}

export function labelOf(id: string): string {
  const key = modelKeyOf(id)
  return key ? MODELS[key].label : printable(id)
}

/** `Opus` for `Opus 5.5`: the label without its version. */
export const shortLabel = (label: string) => label.replace(/ [\d.]+$/, '')

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export const DEFAULT_TTL = 60

/** Keep-warm only pays on the 60-minute cache: on the 5-minute one a ping every few minutes costs more than the rewrite. */
export const KEEP_WARM_TTL = 60

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

export const SMALL_CONTEXT = 20_000

/**
 * Colour for context use, measured against where auto-compaction fires when
 * known (else the whole window): green below 60%, amber to 85%, red after.
 */
export function contextLevel(tokens: number, window: number, compactAt?: number): 'success' | 'warning' | 'error' {
  const toward = contextFill(tokens, window, compactAt)
  return toward >= CONTEXT_CRITICAL ? 'error' : toward >= CONTEXT_WARN ? 'warning' : 'success'
}

export const CONTEXT_WARN = 0.6
export const CONTEXT_CRITICAL = 0.85

/** How far along the context is: toward auto-compaction when known, else toward the whole window. */
export const contextFill = (tokens: number, window: number, compactAt?: number) => tokens / (compactAt && compactAt > 0 ? compactAt : window)

export const SUB_CONTEXT = 30_000
