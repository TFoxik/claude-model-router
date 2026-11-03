import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On } from 'claude-code'

import type { ActiveRoute, ColdGuard, Effort, RouterConfig, WarmHours } from '../../types'
import { fmtLeft } from '../core/format'
import { sumUsd } from '../core/ledger'
import { contextTokensNow, contextTokensOf, mainRoute, routeKeyOfAgent, setConfig, setPlan } from '../core/measure'
import { session } from '../core/session'
import { configOf, isBandShownOf, isPlanOf, nowOf, promptCostOf, setBand, spendOf, warmRunOf } from '../core/state'
import { AUTO_LABELS, FORK, PRESETS, ROUTES, asEffort, effortForLabel, parseSetting, presetOf, resolve, routeForSpawn, routeText, shouldSwitch, withPreset, withRoute } from './routes'
import { routesMobileView, routesPaneView } from './routes-pane'

type $ = EngineInterface

// The engine's scan accepts an atom only in the file that declares it, so other files go through the functions below.
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as ActiveRoute | null)
const draft = atom({ plugin: 'model-router', key: 'draft' } as const, null as RouterConfig | null)

type Decision = { model: string; effort?: Effort; isHeld: boolean }

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  autoEffort: new Map<string, Effort>(),
  decisions: new Map<string, Decision>(),
}

/** What the Routes pane does that another feature owns; the orchestrator binds `$` into each, since `$` goes only into this file's own functions. */
type RoutesPaneLinks = {
  setRouting: (isOn: boolean) => void
  setLearning: (isOn: boolean) => void
  setHandoffs: (isOn: boolean) => void
  setAutoHandoff: (isOn: boolean) => void
  setShowNext: (isOn: boolean) => void
  setCost: (isOn: boolean) => void
  setContext: (isOn: boolean) => void
  setGuard: (mode: ColdGuard) => void
  setTtl: (minutes: number) => void
  setWarmHours: (hours: WarmHours) => void
  setWarm: (isOn: boolean) => void
  setKeepText: (keep: boolean) => void
  openHandoffs: () => void
}

async function decideMain(
  $: $,
  cfg: RouterConfig,
  turnId: string,
  index: number,
  route: string,
  model: string,
  isAfterCompact: boolean,
  effort?: Effort,
): Promise<Decision> {
  const known = mem.decisions.get(turnId)
  if (known !== undefined && index > 0) return known
  const want = resolve(cfg, route)
  const toModel = want.model ?? model
  let toEffort: Effort | undefined =
    want.effort === 'auto' ? (mem.autoEffort.get(turnId) ?? session.lastMain?.effort ?? 'medium') : (want.effort ?? effort)
  let isHeld = false
  const last = session.lastMain
  if (want.effort === 'auto' && last !== undefined && last.route === route) {
    const contextTokens = (await contextTokensNow($)) ?? 0
    const from = { model: last.model, effort: last.effort }
    const to = { model: toModel, effort: toEffort }
    if (!shouldSwitch({ contextTokens, isAfterCompact, from, to, ttlMinutes: cfg.cacheTtlMinutes })) {
      toEffort = last.effort
      isHeld = true
    }
  }
  mem.autoEffort.delete(turnId)
  const decision = { model: toModel, effort: toEffort, isHeld }
  mem.decisions.clear()
  mem.decisions.set(turnId, decision)
  return decision
}

export async function renderRoutesPane($: $, e: Args<'ui.render'>, links: RoutesPaneLinks) {
  const now = await read($, active)
  if (e.surface === 'mobile') return routesMobileView($.ui.resolve(e), now)
  const els = $.ui.resolve(e)
  const [cfg, costs, isPlanning, pending, lastPrompt, usage, isBand, run, at] = await Promise.all([
    configOf($),
    spendOf($),
    isPlanOf($),
    read($, draft),
    promptCostOf($),
    $.session.usage(),
    isBandShownOf($),
    warmRunOf($),
    nowOf($),
  ])
  const sessionModel = now?.model ?? (await $.session.model())
  const data = { cfg, total: sumUsd(Object.values(costs)), now, isPlanning, pending, lastPrompt, contextTokens: contextTokensOf(usage.context.tokens) ?? 0, sessionModel, isBand, warmLeft: run === null ? undefined : fmtLeft(run.until - at) }
  return routesPaneView(els, data, {
    editDraft: fn =>
      void update($, draft, d => {
        const next = fn(d ?? cfg)
        return JSON.stringify(next) === JSON.stringify(cfg) ? null : next
      }),
    toggle: () => links.setRouting(!cfg.isEnabled),
    ...links,
    setBand: isShown => void setBand($, isShown),
    // Only the routes come from the draft, so on/off or a setting changed while it was open is kept.
    apply: async next => {
      await update($, draft, () => null)
      await setConfig($, c => ({ ...c, preset: next.preset, routes: next.routes }))
    },
    discard: () => void update($, draft, () => null),
  })
}

export function registerRouting(on: On): void {
  // Hooks that pass events on fail open: if our own code throws, the event goes on as if we weren't here.
  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.type === 'plan_mode' || e.type === 'plan_mode_reentry') await setPlan($, true)
      if (e.type === 'plan_mode_exit') await setPlan($, false)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await setPlan($, true)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await setPlan($, false)
    return ran
  }).catch(($, e, next) => next(e))
}

/** A subagent runs on the model its route names, unless it is a fork or a workflow's. */
export async function routingOnSpawn($: $, e: Args<'agent.spawn'>): Promise<Args<'agent.spawn'>> {
  const route = routeForSpawn(e)
  const { model } = resolve(await configOf($), route)
  const canRewrite = route !== FORK && e.workflow === undefined
  return canRewrite && model ? { ...e, model } : e
}

/** With auto effort on the main route, a small model reads the prompt to pick the effort for the turn. */
export async function routingOnTurnStart($: $, e: Args<'turn.start'>, cfg: RouterConfig): Promise<void> {
  const { effort } = resolve(cfg, await mainRoute($))
  if (effort === 'auto' && e.text.trim() !== '') {
    const label = await $.model
      .classify(e.text.slice(0, 4000), AUTO_LABELS, { model: 'haiku' })
      .catch(() => undefined)
    mem.autoEffort.set(e.turnId, effortForLabel(label, e.text))
  }
}

/** The model and effort a request runs on: the main loop's route when routing is on, a subagent's own route otherwise. */
export async function routingDecide($: $, e: Args<'turn.step'>, cfg: RouterConfig): Promise<{ route?: string; model: string; effort?: Effort; isHeld: boolean; isAfterCompact: boolean }> {
  let route: string | undefined
  let model = e.model
  let effort = asEffort(e.effort)
  let isHeld = false
  const isAfterCompact = e.agentId === undefined && session.isAfterCompact

  if (e.agentId === undefined) {
    session.isAfterCompact = false
    route = await mainRoute($)
    if (cfg.isEnabled) {
      const decision = await decideMain($, cfg, e.turnId, e.index, route, e.model, isAfterCompact, effort)
      model = decision.model
      effort = decision.effort
      isHeld = decision.isHeld
    }
  } else {
    route = await routeKeyOfAgent($, e.agentId)
    if (route !== undefined && route !== FORK) {
      const want = resolve(cfg, route)
      model = want.model ?? e.model
      if (want.effort !== undefined && want.effort !== 'auto') effort = want.effort
    }
  }
  return { route, model, effort, isHeld, isAfterCompact }
}

export async function routingNoteApplied($: $, a: { route: string; model: string; effort?: Effort; isHeld: boolean; prevRoute?: string; cfg: RouterConfig }): Promise<void> {
  if (a.prevRoute !== undefined && a.prevRoute !== a.route && a.cfg.isEnabled) $.ui.toast(`Route ${a.route}: ${routeText(a.model, a.effort)}`)
  await update($, active, () => ({ route: a.route, model: a.model, effort: a.effort, isHeld: a.isHeld }))
}

export async function routingBandHead($: $): Promise<{ cfg: RouterConfig; now: ActiveRoute | null; pending: RouterConfig | null }> {
  const [cfg, now, pending] = await Promise.all([configOf($), read($, active), read($, draft)])
  return { cfg, now, pending }
}

export async function routingVerb($: $, verb: string, rest: string[], isPerson: boolean): Promise<{ text: string } | undefined> {
  if (!isPerson) return undefined
  if (verb === 'preset') {
    const name = rest[0] ?? ''
    const preset = presetOf(name)
    if (preset === undefined) return { text: `Presets: ${Object.keys(PRESETS).join(', ')}.` }
    await setConfig($, c => withPreset(c, name)!)
    return { text: `Preset ${name}: ${preset.label}.` }
  }
  if (verb === 'set') {
    const [route, model, effort] = rest
    if (route === undefined) return { text: `Routes: ${ROUTES.map(one => one.key).join(', ')}, or sub:<agent-type>.` }
    const setting = parseSetting(route, model, effort)
    if (typeof setting === 'string') return { text: setting }
    await setConfig($, c => withRoute(c, route, setting))
    return { text: `${route} → ${setting.model} · ${setting.effort}.` }
  }
  return undefined
}
