import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveRoute, ColdGuard, Effort, Health, LastUsage, PromptCost, PromptRecord, RouteSpend, RouterConfig, Scope } from '../types'
import {
  AUTO_LABELS,
  DEFAULT_CONFIG,
  EMPTY_PROMPT,
  EMPTY_SPEND,
  ENGINE,
  FORK,
  GUARD_MIN_TOKENS,
  HISTORY_LIMIT,
  PRESETS,
  ROUTES,
  addSpend,
  addLateStep,
  addStep,
  coldForMs,
  commandLabel,
  contextLevel,
  costOf,
  effortForLabel,
  fmtAge,
  kTokens,
  labelOf,
  modelsOf,
  money,
  parseSetting,
  presetOf,
  printable,
  resolve,
  rewriteCause,
  rewriteOf,
  rewritePrice,
  routeForSpawn,
  routeText,
  sanitizeConfig,
  sanitizeHistory,
  shouldSwitch,
  startingConfig,
  subagentCount,
  sumUsd,
  todayUsd,
  withoutText,
  withPreset,
  withRoute,
} from './routes'
import { bandView } from './ui/band'
import { contextMobileView, contextPaneView } from './ui/context-pane'
import { PANES } from './ui/kit'
import type { Open } from './ui/kit'
import { lastPaneView } from './ui/last-pane'
import { routesMobileView, routesPaneView } from './ui/routes-pane'
import { statsFooterView, statsPaneView } from './ui/stats'

// Everything that takes `$` or reads an atom lives in this file: the engine's
// scan follows `$` only into functions declared here and accepts atoms only
// declared here. The views in ui/ are plain functions of the data they're given.
const config = atom({ plugin: 'model-router', key: 'config' } as const, DEFAULT_CONFIG)
const spend = atom({ plugin: 'model-router', key: 'spend' } as const, {} as Record<string, RouteSpend>)
const isPlan = atom({ plugin: 'model-router', key: 'isPlan' } as const, false)
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as ActiveRoute | null)
const draft = atom({ plugin: 'model-router', key: 'draft' } as const, null as RouterConfig | null)
const lastUsage = atom({ plugin: 'model-router', key: 'lastUsage' } as const, null as LastUsage | null)
const health = atom({ plugin: 'model-router', key: 'health' } as const, null as Health | null)
const history = atom({ plugin: 'model-router', key: 'history' } as const, [] as PromptRecord[])
const statsScope = atom({ plugin: 'model-router', key: 'statsScope' } as const, 'repo' as 'repo' | 'all')
const promptCost = atom({ plugin: 'model-router', key: 'promptCost' } as const, null as PromptCost | null)
const isBandShown = atom({ plugin: 'model-router', key: 'isBandShown' } as const, true)

type $ = EngineInterface

// The store keys the atoms kept across sessions are saved under. The engine's
// scan needs each update() to name its atom, so callers update, then save().
const STORE = { config: 'config', history: 'history', statsScope: 'statsScope', bandShown: 'bandShown', modelCommands: 'modelCommands' } as const

/** Saves a value kept across sessions; a failed save keeps the session going. */
async function save<T>($: $, key: string, value: T): Promise<T> {
  await $.store.set(key, value).catch(() => undefined)
  return value
}

// A read that failed, as distinct from a key never saved: nothing is overwritten on the strength of it.
const UNREADABLE = Symbol('unreadable')

const load = ($: $, key: string): Promise<unknown> => $.store.get(key).catch(() => UNREADABLE)

/**
 * Edits start from what is stored, not this session's copy: other sessions
 * share the store, and saving a stale copy would undo what they saved.
 */
async function setConfig(
  $: $,
  fn: (c: RouterConfig) => RouterConfig,
): Promise<RouterConfig> {
  const stored = await load($, STORE.config)
  const next = await update($, config, c => fn(stored === UNREADABLE || stored === undefined ? c : sanitizeConfig(stored)))
  if (stored !== UNREADABLE) await save($, STORE.config, next)
  await refreshStatus($).catch(() => undefined)
  return next
}

/**
 * Remembers that a slash command reached the model, so the cold guard holds it
 * next time; merged with what other sessions learned.
 */
async function learnModelCommand($: $, name: string) {
  if (mem.modelCommands.has(name)) return
  mem.modelCommands.add(name)
  const stored = await load($, STORE.modelCommands)
  if (stored === UNREADABLE) return
  const known = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []
  for (const one of known) mem.modelCommands.add(one)
  await save($, STORE.modelCommands, [...mem.modelCommands])
}

// Prompt-only sources: their commands always reach the model.
const PROMPT_SOURCES: ReadonlySet<string> = new Set(['user', 'mcp'])

/** Whether a slash command starts a model turn: learned from earlier runs, or known from where it comes from. */
async function reachesModel($: $, name: string): Promise<boolean> {
  if (mem.modelCommands.has(name)) return true
  const info = (await $.command.list().catch(() => [])).find(one => one.name === name)
  return info !== undefined && PROMPT_SOURCES.has(info.source)
}

/** The same for history: another session's prompts since this one loaded are kept. Neither saves after a failed read. */
async function setHistory($: $, fn: (records: PromptRecord[]) => PromptRecord[]): Promise<PromptRecord[]> {
  const stored = await load($, STORE.history)
  const next = await update($, history, all => fn(stored === UNREADABLE || stored === undefined ? all : sanitizeHistory(stored)))
  if (stored !== UNREADABLE) await save($, STORE.history, next)
  return next
}

const nowOf = ($: $) => $.clock.now().catch(() => Date.now())

const mainRoute = async ($: $) => ((await read($, isPlan)) ? 'plan' : 'main')

async function routedMainModel($: $, cfg: RouterConfig, fallback: string): Promise<string> {
  return resolve(cfg, await mainRoute($)).model ?? fallback
}

const promptTokens = (last: LastUsage) => last.input + last.cacheRead + last.cacheWrite

/** The price of the next main-loop send when the cache has gone cold over a big context. */
async function coldSend($: $, cfg: RouterConfig): Promise<{ at: number; text: string } | undefined> {
  const last = await read($, lastUsage)
  if (last === null) return undefined
  const ttl = cfg.cacheTtlMinutes
  const coldFor = coldForMs(last.at, await nowOf($), ttl)
  if (coldFor < 0) return undefined
  const context = (await $.session.usage()).context.tokens ?? promptTokens(last)
  if (context < GUARD_MIN_TOKENS) return undefined
  const model = await routedMainModel($, cfg, last.model)
  const { write, warm } = rewritePrice(model, context, ttl)
  return {
    at: last.at,
    text: `the prompt cache went cold ${fmtAge(coldFor)} ago. This send re-writes ~${kTokens(context)} tokens on ${labelOf(model)} = ${money(write)} (warm would be ${money(warm)}).`,
  }
}

async function refreshStatus($: $) {
  const last = await read($, lastUsage)
  if (last === null) return
  const { context, rateLimits } = await $.session.usage()
  const tokens = context.tokens ?? promptTokens(last)
  const prompt = promptTokens(last)
  const five = rateLimits.find(one => one.kind === 'five_hour')
  const seven = rateLimits.find(one => one.kind === 'seven_day')
  const now = await nowOf($)
  const cfg = await read($, config)
  const ttl = cfg.cacheTtlMinutes
  const warmMinutes = Math.max(0, Math.ceil(-coldForMs(last.at, now, ttl) / 60_000))
  if (mem.compactCheckedAt === undefined || now - mem.compactCheckedAt > 10 * 60_000) {
    const { context: detailed } = await $.session.usage({ breakdown: 'summary' })
    const b = detailed.breakdown
    mem.compactAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    mem.compactCheckedAt = now
  }
  const next: Health = {
    cache: prompt > 0 ? Math.round((last.cacheRead / prompt) * 100) : 0,
    warmMinutes,
    ctx: context.percent ?? Math.round((tokens / context.window) * 100),
    ctxLevel: contextLevel(tokens, context.window, mem.compactAt),
    last: (await read($, promptCost))?.usd ?? last.usd,
    ...(warmMinutes === 0 && tokens >= GUARD_MIN_TOKENS
      ? { coldUsd: rewritePrice(await routedMainModel($, cfg, last.model), tokens, ttl).write }
      : {}),
    ...(five ? { fiveHour: Math.round(five.percentUsed) } : {}),
    ...(seven ? { sevenDay: Math.round(seven.percentUsed) } : {}),
  }
  await update($, health, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
}

function recordOf(meta: { label: string; text: string; at: number }, p: PromptCost): PromptRecord {
  return {
    at: meta.at,
    repo: mem.repo,
    label: meta.label,
    text: meta.text,
    usd: p.usd,
    requests: p.requests,
    agents: subagentCount(p),
    models: modelsOf(p),
    rewrites: p.rewrites,
  }
}

async function recordPrompt($: $) {
  const p = await read($, promptCost)
  const meta = mem.current
  mem.current = undefined
  if (p === null || meta === undefined || p.usd <= 0) return
  const rec = recordOf(meta, p)
  await setHistory($, all => [...all, rec].slice(-HISTORY_LIMIT))
}

async function renderLastPane($: $, e: Args<'ui.render'>) {
  return lastPaneView($.ui.resolve(e), await read($, promptCost))
}

const openPane = ($: $): Open => pane => void $.ui.open(PANES[pane])

/** Saved history plus the prompt still running, every repo; the Stats pane narrows it to one. */
async function allRecords($: $): Promise<{ records: PromptRecord[]; now: number }> {
  const [saved, live, now] = await Promise.all([read($, history), read($, promptCost), nowOf($)])
  const current = mem.current
  return { records: live && current && live.usd > 0 ? [...saved, recordOf(current, live)] : saved, now }
}

async function renderStatsFooter($: $, e: Args<'ui.render'>, modes: readonly string[]) {
  const { records, now } = await allRecords($)
  return statsFooterView($.ui.resolve(e), { modes, today: todayUsd(records, now) }, { open: openPane($) })
}

async function renderStatsPane($: $, e: Args<'ui.render'>) {
  const [scope, { records: all, now }] = await Promise.all([read($, statsScope), allRecords($)])
  const records = scope === 'repo' ? all.filter(r => r.repo === mem.repo) : all
  const setScope = async (next: Scope) => void save($, STORE.statsScope, await update($, statsScope, () => next))
  return statsPaneView($.ui.resolve(e), { records, scope, repo: mem.repo, now }, { setScope })
}

const setBand = async ($: $, isShown: boolean) => save($, STORE.bandShown, await update($, isBandShown, () => isShown))

async function renderBand($: $, e: Args<'ui.render'>) {
  const [cfg, now, pending, costs, hp] = await Promise.all([read($, config), read($, active), read($, draft), read($, spend), read($, health)])
  const data = { cfg, now, pending, total: sumUsd(Object.values(costs)), health: hp }
  return bandView($.ui.resolve(e), data, { open: openPane($), hide: () => void setBand($, false) })
}

async function renderCtxPane($: $, e: Args<'ui.render'>) {
  if (e.surface === 'mobile') return contextMobileView($.ui.resolve(e))
  const columns = (e.component === 'Pane' ? e.props.bodyColumns : undefined) || 80
  const { context } = await $.session.usage({ breakdown: 'summary', columns })
  return contextPaneView($.ui.resolve(e), { breakdown: context.breakdown, isTerminal: e.surface === 'terminal', columns })
}

async function renderPane($: $, e: Args<'ui.render'>) {
  const now = await read($, active)
  if (e.surface === 'mobile') return routesMobileView($.ui.resolve(e), now)
  const els = $.ui.resolve(e)
  const [cfg, costs, isPlanning, pending, lastPrompt, usage] = await Promise.all([
    read($, config),
    read($, spend),
    read($, isPlan),
    read($, draft),
    read($, promptCost),
    $.session.usage(),
  ])
  const sessionModel = now?.model ?? (await $.session.model())
  const data = { cfg, costs, now, isPlanning, pending, lastPrompt, contextTokens: usage.context.tokens ?? 0, sessionModel }
  return routesPaneView(els, data, {
    editDraft: fn =>
      void update($, draft, d => {
        const next = fn(d ?? cfg)
        return JSON.stringify(next) === JSON.stringify(cfg) ? null : next
      }),
    toggle: () => void setConfig($, c => ({ ...c, isEnabled: !c.isEnabled })),
    // Only the routes come from the draft, so on/off or a setting changed while it was open is kept.
    apply: async next => {
      await update($, draft, () => null)
      await setConfig($, c => ({ ...c, preset: next.preset, routes: next.routes }))
    },
    discard: () => void update($, draft, () => null),
  })
}

const GUARD_TEXT: Record<ColdGuard, string> = {
  refuse: 'Cold sends are dropped once with their price; the resend goes through.',
  warn: 'Cold sends go through with their price shown.',
  off: 'Cold-send guard off.',
}

const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

const USAGE = '[stats [clear | text on|off] | context | last | preset <name> | set <route> <model> [effort] | on | off | band on|off | guard refuse|warn|off | ttl 5|60]'

// Origins a person typed or drove: only these may change the routes, and only these are held by the cold guard.
const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

type Decision = { model: string; effort?: Effort; isHeld: boolean }

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  autoEffort: new Map<string, Effort>(),
  decisions: new Map<string, Decision>(),
  lastMain: undefined as { route: string; model: string; effort?: Effort; at: number } | undefined,
  isAfterCompact: false,
  repo: 'unknown',
  // The label of the prompt the next turn.start opens; undefined while a prompt's turns run.
  pendingPrompt: 'prompt' as string | undefined,
  // Each agent's route, label and the prompt that started it (its `current.at`), when spawned in view.
  agents: new Map<string, { route: string; label?: string; promptAt?: number }>(),
  tick: undefined as Timer | undefined,
  current: undefined as { label: string; text: string; at: number } | undefined,
  compactAt: undefined as number | undefined,
  compactCheckedAt: undefined as number | undefined,
  coldAckedAt: undefined as number | undefined,
  // Slash commands seen to start a model turn, and the command that ran last, until a turn shows whether it did.
  modelCommands: new Set<string>(),
  lastCommand: undefined as string | undefined,
}

async function routeOfAgent($: $, agentId: string): Promise<string | undefined> {
  const known = mem.agents.get(agentId)
  if (known !== undefined) return known.route
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed !== undefined) {
    const route = listed.teammateId !== undefined ? 'teammate' : listed.type === FORK ? FORK : `sub:${listed.type}`
    mem.agents.set(agentId, { route })
    return route
  }
  // A workflow's agents and the engine's own forks (compaction, memory) are in no list: left on their model.
  return undefined
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
    want.effort === 'auto' ? (mem.autoEffort.get(turnId) ?? mem.lastMain?.effort ?? 'medium') : (want.effort ?? effort)
  let isHeld = false
  const last = mem.lastMain
  if (want.effort === 'auto' && last !== undefined && last.route === route) {
    const contextTokens = (await $.session.usage()).context.tokens ?? 0
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

type StepOutcome = {
  cfg: RouterConfig
  model: string
  effort?: Effort
  isHeld: boolean
  isAfterCompact: boolean
  usage: (Parameters<typeof costOf>[0] & { model: string }) | null | undefined
}

/** Counts one finished request: per-route spend, the prompt's breakdown, and, for the main loop, the band's facts. */
async function recordStep($: $, agentId: string | undefined, key: string, s: StepOutcome) {
  const stepAt = await nowOf($)
  const isMain = agentId === undefined
  const usage = s.usage
  if (usage) {
    const ttl = s.cfg.cacheTtlMinutes
    const label = isMain ? (key === 'plan' ? 'Main loop (plan mode)' : 'Main loop') : (mem.agents.get(agentId)?.label ?? key)
    const cause = isMain
      ? rewriteCause({ isAfterCompact: s.isAfterCompact, prevAt: mem.lastMain?.at, now: stepAt, ttlMinutes: ttl, from: mem.lastMain, to: { model: s.model, effort: s.effort } })
      : undefined
    const rewrite = rewriteOf(usage, usage.model, cause, ttl)
    await update($, spend, all => ({ ...all, [key]: addSpend(all[key] ?? EMPTY_SPEND, usage, usage.model, ttl) }))
    const promptAt = isMain ? undefined : mem.agents.get(agentId)?.promptAt
    if (promptAt !== undefined && promptAt !== mem.current?.at) {
      // A background agent outlived the prompt that started it: its cost belongs to that prompt's saved record.
      await setHistory($, all => all.map(r => (r.at === promptAt && r.repo === mem.repo ? addLateStep(r, { usage, effort: s.effort, ttlMinutes: ttl }) : r)))
    } else {
      await update($, promptCost, p => addStep(p ?? EMPTY_PROMPT, { id: agentId ?? key, route: key, label, effort: s.effort, usage, ttlMinutes: ttl, rewrite }))
    }
    if (isMain) {
      await update($, lastUsage, () => ({
        model: usage.model,
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        usd: costOf(usage, usage.model, ttl),
        at: stepAt,
      }))
    }
  }
  if (!isMain) return
  if (mem.lastMain !== undefined && mem.lastMain.route !== key && s.cfg.isEnabled) $.ui.toast(`Route ${key}: ${routeText(s.model, s.effort)}`)
  mem.lastMain = { route: key, model: s.model, effort: s.effort, at: stepAt }
  await update($, active, () => ({ route: key, model: s.model, effort: s.effort, isHeld: s.isHeld }))
  await refreshStatus($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [stored, saved, scope, band, learned, repo] = await Promise.all([
      load($, STORE.config),
      load($, STORE.history),
      load($, STORE.statsScope),
      load($, STORE.bandShown),
      load($, STORE.modelCommands),
      $.session.repo().catch(() => null),
    ])
    if (Array.isArray(learned)) for (const one of learned) if (typeof one === 'string') mem.modelCommands.add(one)
    const kept = saved === UNREADABLE ? [] : sanitizeHistory(saved)
    if (stored === UNREADABLE || saved === UNREADABLE) {
      $.ui.log('model-router: could not read saved settings or history; using defaults for this session and saving nothing over them.')
    } else {
      const cfg = startingConfig(stored, kept.length > 0)
      await update($, config, () => cfg)
      // Saved on first run so the history check above decides once: a fresh install keeps `inherit` after it gains history.
      if (stored === undefined) await save($, STORE.config, cfg)
    }
    await update($, history, () => kept)
    if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
    if (typeof band === 'boolean') await update($, isBandShown, () => band)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    mem.repo = repo?.name ?? (root.split('/').pop() || 'unknown')
    $.ui.status(undefined)
    await refreshStatus($).catch(() => undefined)
    mem.tick?.cancel()
    mem.tick = $.clock.every(60_000, () => void refreshStatus($).catch(() => undefined))
    await $.command.register({ name: 'route', description: 'Model router: open the pane, or one of the verbs', argumentHint: USAGE })
    const hasCacheTax = (await read($, config)).coldGuard !== 'off' && (await $.command.list().catch(() => [])).some(one => one.name === 'cache-tax')
    if (hasCacheTax) {
      $.ui.log('model-router: cache-tax is installed too, so a cold send is guarded twice. Run /route guard off to leave it to cache-tax.')
    }
    return next(e)
  })

  // Hooks that pass events on fail open: if our own code throws, the event goes on as if we weren't here.
  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.type === 'plan_mode' || e.type === 'plan_mode_reentry') await update($, isPlan, () => true)
      if (e.type === 'plan_mode_exit') await update($, isPlan, () => false)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await update($, isPlan, () => true)
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await update($, isPlan, () => false)
    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) mem.isAfterCompact = true
    return done
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const route = routeForSpawn(e)
    const { model } = resolve(await read($, config), route)
    const canRewrite = route !== FORK && e.workflow === undefined
    const started = await next(canRewrite && model ? { ...e, model } : e)
    if (started.agentId !== undefined) {
      mem.agents.set(started.agentId, { route, label: printable(`${e.subagentType} · ${e.description}`), promptAt: mem.current?.at })
    }
    return started
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      const cfg = await read($, config)
      const guard = cfg.coldGuard
      // Only a person can resend a dropped message; a notification, trigger or peer message would be lost.
      if (guard !== 'off' && USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) {
        const cold = await coldSend($, cfg).catch(() => undefined)
        if (cold !== undefined && guard === 'warn') $.ui.log(`model-router: ${cold.text} Sending anyway.`)
        if (cold !== undefined && guard === 'refuse' && mem.coldAckedAt !== cold.at) {
          mem.coldAckedAt = cold.at
          return { drop: `model-router: ${cold.text} Send it again to pay it, or /clear and start from a note.` }
        }
      }
      mem.pendingPrompt = commandLabel(e.text)
      if (!e.text.trimStart().startsWith('/')) mem.lastCommand = undefined
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command === 'route') return next(e)
    const cfg = await read($, config)
    if (cfg.coldGuard !== 'off' && USER_ORIGINS.has(e.origin.kind)) {
      const cold = await coldSend($, cfg).catch(() => undefined)
      if (cold !== undefined && (await reachesModel($, e.command))) {
        if (cfg.coldGuard === 'warn') $.ui.log(`model-router: ${cold.text} Running /${e.command} anyway.`)
        else if (mem.coldAckedAt !== cold.at) {
          mem.coldAckedAt = cold.at
          return { text: `model-router: ${cold.text} Run /${e.command} again to pay it, or /clear and start from a note.` }
        }
      }
    }
    mem.pendingPrompt = `/${e.command}`
    mem.lastCommand = e.command
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await recordPrompt($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (mem.lastCommand !== undefined) {
      const name = mem.lastCommand
      mem.lastCommand = undefined
      await learnModelCommand($, name).catch(() => undefined)
    }
    const [cfg, route] = await Promise.all([read($, config), mainRoute($)])
    if (mem.pendingPrompt !== undefined) {
      const label = mem.pendingPrompt
      mem.pendingPrompt = undefined
      await recordPrompt($).catch(() => undefined)
      mem.current = { label, text: cfg.keepPromptText ? printable(e.text.slice(0, 120)) : '', at: await nowOf($) }
      await update($, promptCost, () => EMPTY_PROMPT)
    }
    const { effort } = resolve(cfg, route)
    if (effort === 'auto' && e.text.trim() !== '') {
      const label = await $.model
        .classify(e.text.slice(0, 4000), AUTO_LABELS, { model: 'haiku' })
        .catch(() => undefined)
      mem.autoEffort.set(e.turnId, effortForLabel(label, e.text))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const cfg = await read($, config)
    let route: string | undefined
    let model = e.model
    let effort = asEffort(e.effort)
    let isHeld = false
    const isAfterCompact = e.agentId === undefined && mem.isAfterCompact

    if (e.agentId === undefined) {
      mem.isAfterCompact = false
      route = await mainRoute($)
      if (cfg.isEnabled) {
        const decision = await decideMain($, cfg, e.turnId, e.index, route, e.model, isAfterCompact, effort)
        model = decision.model
        effort = decision.effort
        isHeld = decision.isHeld
      }
    } else {
      route = await routeOfAgent($, e.agentId)
      if (route !== undefined && route !== FORK) {
        const want = resolve(cfg, route)
        model = want.model ?? e.model
        if (want.effort !== undefined && want.effort !== 'auto') effort = want.effort
      }
    }

    const isChanged = model !== e.model || effort !== asEffort(e.effort)
    const result = yield* next(isChanged ? { ...e, model, ...(effort ? { effort } : {}) } : e)

    // Bookkeeping never fails the request it is counting.
    await recordStep($, e.agentId, route ?? ENGINE, { cfg, model, effort, isHeld, isAfterCompact, usage: result.usage }).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb = 'route', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (Object.hasOwn(PANES, verb) && rest.length === 0) {
      const pane = verb as keyof typeof PANES
      openPane($)(pane)
      return { text: `${PANES[pane].title} pane opened.` }
    }
    if (!USER_ORIGINS.has(e.origin.kind)) return { text: `model-router: /route ${verb} only runs when you type it.` }
    if (verb === 'stats' && rest[0] === 'clear') {
      await setHistory($, () => [])
      return { text: 'Prompt history cleared.' }
    }
    if (verb === 'stats' && rest[0] === 'text' && (rest[1] === 'on' || rest[1] === 'off')) {
      const keep = rest[1] === 'on'
      await setConfig($, c => ({ ...c, keepPromptText: keep }))
      if (keep) return { text: 'Stats keeps the first 120 characters of each prompt again.' }
      if (mem.current) mem.current.text = ''
      await setHistory($, withoutText)
      return { text: 'Stats keeps only labels and costs now; saved prompt text was removed.' }
    }
    if (verb === 'ttl') {
      const minutes = Number(rest[0])
      if (minutes !== 5 && minutes !== 60) return { text: 'Usage: /route ttl 5|60 (prompt-cache lifetime in minutes)' }
      await setConfig($, c => ({ ...c, cacheTtlMinutes: minutes }))
      return { text: `Cache lifetime set to ${minutes} minutes.` }
    }
    if (verb === 'guard') {
      const mode = rest[0] as ColdGuard
      if (!Object.hasOwn(GUARD_TEXT, mode ?? '')) return { text: 'Usage: /route guard refuse|warn|off (what a send onto a cold prompt cache does)' }
      await setConfig($, c => ({ ...c, coldGuard: mode }))
      return { text: GUARD_TEXT[mode] }
    }
    if (verb === 'band') {
      const isShown = rest[0] !== 'off'
      await setBand($, isShown)
      return { text: `Model router band ${isShown ? 'shown' : 'hidden'}.` }
    }
    if (verb === 'on' || verb === 'off') {
      await setConfig($, c => ({ ...c, isEnabled: verb === 'on' }))
      return { text: `Model router ${verb === 'on' ? 'enabled' : 'disabled'}.` }
    }
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
    return { text: `Usage: /route ${USAGE}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANES.route.id }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.last.id }, ($, e) => renderLastPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.context.id }, ($, e) => renderCtxPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.stats.id }, ($, e) => renderStatsPane($, e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode') return next(e)
    return renderStatsFooter($, e, e.props.modes)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)
    return renderBand($, e)
  })
}
