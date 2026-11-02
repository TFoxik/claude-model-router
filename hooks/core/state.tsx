import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Carried, Health, LastUsage, PromptCost, PromptRecord, RouteSpend, RouterConfig } from '../../types'
import { DEFAULT_CONFIG, sanitizeConfig } from './config'
import { sanitizeHistory } from './ledger'
import { session } from './session'

// The engine's scan accepts an atom only in the file that declares it, so other files go through the accessors below.
const config = atom({ plugin: 'model-router', key: 'config' } as const, DEFAULT_CONFIG)
const spend = atom({ plugin: 'model-router', key: 'spend' } as const, {} as Record<string, RouteSpend>)
const isPlan = atom({ plugin: 'model-router', key: 'isPlan' } as const, false)
const lastUsage = atom({ plugin: 'model-router', key: 'lastUsage' } as const, null as LastUsage | null)
const health = atom({ plugin: 'model-router', key: 'health' } as const, null as Health | null)
const history = atom({ plugin: 'model-router', key: 'history' } as const, [] as PromptRecord[])
const promptCost = atom({ plugin: 'model-router', key: 'promptCost' } as const, null as PromptCost | null)
const isBandShown = atom({ plugin: 'model-router', key: 'isBandShown' } as const, true)
// Atoms outlive a hot reload of this code and `session` does not: this keeps what the session would lose with it.
const carried = atom({ plugin: 'model-router', key: 'carried' } as const, null as Carried | null)

type $ = EngineInterface

// The store keys the atoms kept across sessions are saved under. The engine's
// scan needs each update() to name its atom, so callers update, then save().
export const STORE = { config: 'config', history: 'history', statsScope: 'statsScope', bandShown: 'bandShown', modelCommands: 'modelCommands', lessons: 'lessons', toolUse: 'toolUse', connectorNames: 'connectorNames', handoffs: 'handoffs', handoffScope: 'handoffScope', version: 'version' } as const

/** Saves a value kept across sessions; a failed save keeps the session going. */
export async function save<T>($: $, key: string, value: T): Promise<T> {
  await $.store.set(key, value).catch(() => undefined)
  return value
}

// A read that failed, as distinct from a key never saved: nothing is overwritten on the strength of it.
export const UNREADABLE = Symbol('unreadable')

export async function load($: $, key: string): Promise<unknown> {
  return $.store.get(key).catch(() => UNREADABLE)
}

export async function nowOf($: $): Promise<number> {
  return $.clock.now().catch(() => Date.now())
}

export async function configOf($: $): Promise<RouterConfig> {
  return read($, config)
}

/**
 * Edits start from what is stored, not this session's copy: other sessions
 * share the store, and saving a stale copy would undo what they saved.
 */
export async function writeConfig($: $, fn: (c: RouterConfig) => RouterConfig): Promise<RouterConfig> {
  const stored = await load($, STORE.config)
  const next = await update($, config, c => fn(stored === UNREADABLE || stored === undefined ? c : sanitizeConfig(stored)))
  if (stored !== UNREADABLE) await save($, STORE.config, next)
  return next
}

export async function initConfig($: $, cfg: RouterConfig): Promise<void> {
  await update($, config, () => cfg)
}

export async function historyOf($: $): Promise<PromptRecord[]> {
  return read($, history)
}

/** The same for history: another session's prompts since this one loaded are kept. Neither saves after a failed read. */
export async function setHistory($: $, fn: (records: PromptRecord[]) => PromptRecord[]): Promise<PromptRecord[]> {
  const stored = await load($, STORE.history)
  const next = await update($, history, all => fn(stored === UNREADABLE || stored === undefined ? all : sanitizeHistory(stored)))
  if (stored !== UNREADABLE) await save($, STORE.history, next)
  return next
}

export async function initHistory($: $, records: PromptRecord[]): Promise<void> {
  await update($, history, () => records)
}

export async function promptCostOf($: $): Promise<PromptCost | null> {
  return read($, promptCost)
}

export async function updatePromptCost($: $, fn: (p: PromptCost | null) => PromptCost | null): Promise<PromptCost | null> {
  return update($, promptCost, fn)
}

export async function spendOf($: $): Promise<Record<string, RouteSpend>> {
  return read($, spend)
}

export async function updateSpend($: $, fn: (all: Record<string, RouteSpend>) => Record<string, RouteSpend>): Promise<Record<string, RouteSpend>> {
  return update($, spend, fn)
}

export async function lastUsageOf($: $): Promise<LastUsage | null> {
  return read($, lastUsage)
}

export async function setLastUsage($: $, value: LastUsage): Promise<void> {
  await update($, lastUsage, () => value)
}

export async function healthOf($: $): Promise<Health | null> {
  return read($, health)
}

export async function setHealth($: $, next: Health): Promise<void> {
  await update($, health, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
}

export async function isPlanOf($: $): Promise<boolean> {
  return read($, isPlan)
}

export async function setIsPlan($: $, isOn: boolean): Promise<void> {
  await update($, isPlan, () => isOn)
}

export async function isBandShownOf($: $): Promise<boolean> {
  return read($, isBandShown)
}

export async function setBand($: $, isShown: boolean): Promise<boolean> {
  return save($, STORE.bandShown, await update($, isBandShown, () => isShown))
}

export async function initBand($: $, isShown: boolean): Promise<void> {
  await update($, isBandShown, () => isShown)
}

export async function carriedOf($: $): Promise<Carried | null> {
  return read($, carried)
}

/** Copies what a hot reload would drop into an atom; session.start puts it back. */
export async function carry($: $): Promise<void> {
  const next: Carried = { ...session.kept, used: { ...session.kept.used } }
  await update($, carried, () => next)
}
