import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveRoute, Carried, ColdGuard, Effort, Health, LastUsage, Lesson, LessonKind, PromptCost, PromptRecord, RouteSpend, RouterConfig, Scope } from '../types'
import {
  CONCEPTS,
  TOAST_MS,
  TOPICS,
  awayText,
  capLessons,
  lessonFromAdvice,
  lessonFromAutoHandoff,
  lessonFromCompact,
  lessonFromContext,
  lessonFromExpiry,
  lessonFromExploration,
  lessonFromPlanToggle,
  lessonFromRewrite,
  lessonsFromPrompt,
  pickToast,
  sanitizeLessons,
  toastText,
  unreadCount,
} from './lessons'
import type { LessonDraft } from './lessons'
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
  isLessonKind,
  kTokens,
  labelOf,
  modelsOf,
  money,
  parseSetting,
  plural,
  presetOf,
  printable,
  typedText,
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
  warmMinutesLeft,
  withoutText,
  withPreset,
  withRoute,
} from './routes'
import { HANDOFF_DIR, HANDOFF_LABEL, HANDOFF_PROMPT, handoffPath, pendingAfter, segment, shouldAutoHandoff, tildePath } from './handoff'
import type { PendingHandoff } from './handoff'
import { EXPLORE_MIN, NO_STEPS, exploredTokens, hasHandoffCommand, isCorrection, isExplorationHeavy, openSteps, planEventOf, stepsAfter } from './signals'
import type { Steps } from './signals'
import { adviseSession, boundaryOf } from './strategy'
import type { Boundary } from './strategy'
import { messagesOf, tokensByServer } from './tips'
import { DEV_PATIENCE, PATIENCE, applyUsage, connectedServers, idleItems, idleReport, idleTips, itemOfCommand, itemOfToolCall, mcpKey, patienceText, pluginKey, pluginName, pluginOfMcpTool, pluginServer, sanitizeUsage } from './usage'
import type { ItemKey, Patience, UsageStore } from './usage'
import { bandView } from './ui/band'
import { contextMobileView, contextPaneView } from './ui/context-pane'
import { PANES } from './ui/kit'
import type { Open } from './ui/kit'
import { lastPaneView } from './ui/last-pane'
import { learnPaneView } from './ui/learn-pane'
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
const lessons = atom({ plugin: 'model-router', key: 'lessons' } as const, [] as Lesson[])
const lessonsReadAt = atom({ plugin: 'model-router', key: 'lessonsReadAt' } as const, 0)
const learnOpen = atom({ plugin: 'model-router', key: 'learnOpen' } as const, [] as LessonKind[])
const learnRows = atom({ plugin: 'model-router', key: 'learnRows' } as const, [] as string[])
const learnScope = atom({ plugin: 'model-router', key: 'learnScope' } as const, 'repo' as Scope)
// Atoms outlive a hot reload of this code and `mem` does not: this keeps what the session would lose with it.
const carried = atom({ plugin: 'model-router', key: 'carried' } as const, null as Carried | null)

type $ = EngineInterface

// The store keys the atoms kept across sessions are saved under. The engine's
// scan needs each update() to name its atom, so callers update, then save().
const STORE = { config: 'config', history: 'history', statsScope: 'statsScope', bandShown: 'bandShown', modelCommands: 'modelCommands', lessons: 'lessons', lessonsReadAt: 'lessonsReadAt', learnScope: 'learnScope', toolUse: 'toolUse' } as const

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
  const info = (await listCommands($)).find(one => one.name === name)
  return info !== undefined && PROMPT_SOURCES.has(info.source)
}

/** The same for history: another session's prompts since this one loaded are kept. Neither saves after a failed read. */
async function setHistory($: $, fn: (records: PromptRecord[]) => PromptRecord[]): Promise<PromptRecord[]> {
  const stored = await load($, STORE.history)
  const next = await update($, history, all => fn(stored === UNREADABLE || stored === undefined ? all : sanitizeHistory(stored)))
  if (stored !== UNREADABLE) await save($, STORE.history, next)
  return next
}

async function setLessons($: $, fn: (all: Lesson[]) => Lesson[]): Promise<Lesson[]> {
  const stored = await load($, STORE.lessons)
  const next = await update($, lessons, all => fn(stored === UNREADABLE || stored === undefined ? all : sanitizeLessons(stored)))
  if (stored !== UNREADABLE) await save($, STORE.lessons, next)
  return next
}

/** Keeps what the finished main-loop turn taught, and toasts the one most worth it. */
async function flushLessons($: $) {
  const drafts = mem.pendingLessons
  mem.pendingLessons = []
  const [cfg, p] = await Promise.all([read($, config), read($, promptCost)])
  if (!cfg.isLearning) return
  await teach($, [...drafts, ...(p === null ? [] : lessonsFromPrompt(p, cfg.cacheTtlMinutes))], await nowOf($))
}

/** Writes the auto-handoff turn's reply to its file; an interrupted, failed or empty turn saves nothing. */
async function finishHandoff($: $, e: Args<'turn.complete'>) {
  const asked = mem.handoff
  if (asked?.turnId === undefined || asked.turnId !== e.turnId) return
  mem.handoff = undefined
  if (e.reason !== 'answer' || e.answer.trim() === '' || mem.home === undefined) return
  const [now, sessionId, cost, cfg] = await Promise.all([nowOf($), $.session.id().catch(() => mem.kept.sessionId), read($, promptCost), read($, config)])
  const path = handoffPath(mem.home, mem.repo, now, sessionId ?? 'session')
  try {
    await $.fs.write(path, `${e.answer.trim()}\n`)
  } catch (err) {
    $.ui.log(`model-router: could not save the auto-handoff to ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  mem.handoffPath = path
  if (cfg.isLearning) {
    const avoidedUsd = rewritePrice(asked.model, asked.tokens, cfg.cacheTtlMinutes).write
    mem.pendingLessons.push(lessonFromAutoHandoff({ spentUsd: cost?.usd ?? 0, avoidedUsd, tokens: asked.tokens, path: tildePath(path, mem.home) }))
  }
  await refreshStatus($).catch(() => undefined)
}

/** Keeps the lessons of topics not muted and toasts the one most worth it, if any is due. */
async function teach($: $, drafts: readonly LessonDraft[], now: number) {
  const { learnMuted } = await read($, config)
  const all = drafts.filter(d => !learnMuted.includes(d.kind))
  if (all.length === 0) return
  let toast: string | undefined
  await setLessons($, earlier => {
    const fresh: Lesson[] = all.map(d => ({ ...d, at: now, repo: mem.repo }))
    const pick = pickToast(fresh, earlier, now)
    toast = pick && toastText(pick, earlier)
    return capLessons([...earlier, ...fresh.map(one => (one === pick ? { ...one, isToasted: true } : one))])
  })
  if (toast !== undefined) $.ui.toast(toast, { timeoutMs: TOAST_MS })
}

/** Learn mode on or off; off drops what the running turn had drafted, so nothing is kept or toasted from it. */
async function setLearning($: $, isOn: boolean) {
  if (!isOn) mem.pendingLessons = []
  await setConfig($, c => ({ ...c, isLearning: isOn }))
}

async function setAutoHandoff($: $, isOn: boolean) {
  await setConfig($, c => ({ ...c, autoHandoff: isOn }))
}

async function setShowNext($: $, isOn: boolean) {
  await setConfig($, c => ({ ...c, showNext: isOn }))
}

async function setMuted($: $, kind: LessonKind, isMuted: boolean) {
  await setConfig($, c => ({ ...c, learnMuted: isMuted ? [...new Set([...c.learnMuted, kind])] : c.learnMuted.filter(one => one !== kind) }))
}

/** Lessons the Learn pane and its count cover: this repo's, or every repo's under All. */
const inScope = (all: readonly Lesson[], scope: Scope) => (scope === 'repo' ? all.filter(one => one.repo === mem.repo) : all)

async function markLessonsRead($: $) {
  const [all, scope] = await Promise.all([read($, lessons), read($, learnScope)])
  const newest = Math.max(0, ...inScope(all, scope).map(one => one.at))
  await save($, STORE.lessonsReadAt, await update($, lessonsReadAt, () => newest))
}

const nowOf = ($: $) => $.clock.now().catch(() => Date.now())

/** Copies what a hot reload would drop into an atom; session.start puts it back. */
async function carry($: $) {
  const next: Carried = { ...mem.kept, used: { ...mem.kept.used } }
  await update($, carried, () => next)
}

const mainRoute = async ($: $) => ((await read($, isPlan)) ? 'plan' : 'main')

/** A main-loop route's model and effort, falling back to what the session runs. */
function loopRoute(cfg: RouterConfig, route: string, fallback: { model: string; effort?: string }) {
  const r = resolve(cfg, route)
  return { model: r.model ?? fallback.model, effort: r.effort ?? fallback.effort }
}

async function routedMainModel($: $, cfg: RouterConfig, fallback: string): Promise<string> {
  return loopRoute(cfg, await mainRoute($), { model: fallback }).model
}

/**
 * Plan mode on or off. The engine raises no event on the toggle itself, so on
 * entering, the cost of getting here is already being paid; the lesson warns of the way back.
 */
async function setPlan($: $, isOn: boolean) {
  const was = await read($, isPlan)
  await update($, isPlan, () => isOn)
  const cfg = await read($, config)
  if (was || !isOn || !cfg.isLearning) return
  const session = mem.lastMain ?? { model: await $.session.model() }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const draft = lessonFromPlanToggle(loopRoute(cfg, 'plan', session), loopRoute(cfg, 'main', session), tokens, cfg.cacheTtlMinutes)
  if (draft !== undefined) mem.pendingLessons.push(draft)
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

/** `/route away`: the ways to step away, priced for this session as it stands. */
async function awayReport($: $): Promise<string> {
  const last = await read($, lastUsage)
  if (last === null) return 'Nothing is cached in this session yet.'
  const cfg = await read($, config)
  const tokens = (await $.session.usage()).context.tokens ?? promptTokens(last)
  const warmMinutes = warmMinutesLeft(last.at, await nowOf($), cfg.cacheTtlMinutes)
  return awayText({ tokens, model: await routedMainModel($, cfg, last.model), ttlMinutes: cfg.cacheTtlMinutes, warmMinutes })
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
  const warmMinutes = warmMinutesLeft(last.at, now, ttl)
  if (mem.compactCheckedAt === undefined || now - mem.compactCheckedAt > 10 * 60_000) {
    const { context: detailed } = await $.session.usage({ breakdown: 'summary' })
    const b = detailed.breakdown
    mem.compactAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    mem.messagesShare = b && b.totalTokens > 0 ? messagesOf(b) / b.totalTokens : undefined
    mem.compactCheckedAt = now
  }
  const model = await routedMainModel($, cfg, last.model)
  const advice = adviseSession({ tokens, window: context.window, compactAt: mem.compactAt, model, ttlMinutes: ttl, warmMinutes, messagesShare: mem.messagesShare, boundary: mem.boundary, ...signalFacts() })
  const next: Health = {
    cache: prompt > 0 ? Math.round((last.cacheRead / prompt) * 100) : 0,
    warmMinutes,
    ctx: context.percent ?? Math.round((tokens / context.window) * 100),
    ctxLevel: contextLevel(tokens, context.window, mem.compactAt),
    last: (await read($, promptCost))?.usd ?? last.usd,
    ...(warmMinutes === 0 && tokens >= GUARD_MIN_TOKENS ? { coldUsd: rewritePrice(model, tokens, ttl).write } : {}),
    ...(five ? { fiveHour: Math.round(five.percentUsed) } : {}),
    ...(seven ? { sevenDay: Math.round(seven.percentUsed) } : {}),
    ...(advice.verdict === 'continue' || !cfg.showNext ? {} : { advice: { verdict: advice.verdict, reason: advice.reason, text: advice.text, command: advice.command } }),
  }
  const prev = await read($, health)
  await update($, health, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
  void maybeAutoHandoff($, cfg, { warmMinutes, tokens, model }).catch(() => undefined)
  if (!cfg.isLearning) return
  for (const draft of [lessonFromContext(prev?.ctxLevel, next.ctxLevel, tokens, model, ttl, mem.compactAt !== undefined), ...(cfg.showNext ? [lessonFromAdvice(prev?.advice, advice)] : [])]) {
    if (draft !== undefined) mem.pendingLessons.push(draft)
  }
  // The one lesson that can't wait for a turn to end: by then the cache has gone cold.
  const expiring = lessonFromExpiry(prev?.warmMinutes, warmMinutes, ttl, tokens, model)
  if (expiring !== undefined) await teach($, [expiring], now).catch(() => undefined)
}

/** In the cache's last minutes with work open, asks Claude for a handoff while reading the context is still cheap. */
async function maybeAutoHandoff($: $, cfg: RouterConfig, warm: { warmMinutes: number; tokens: number; model: string }) {
  const facts = {
    isOn: cfg.autoHandoff,
    isArmed: mem.handoffArmed && mem.handoff === undefined,
    isIdle: !mem.isTurnRunning,
    isPromptEmpty: true,
    canSave: mem.home !== undefined,
    warmMinutes: warm.warmMinutes,
    ttlMinutes: cfg.cacheTtlMinutes,
    tokens: warm.tokens,
    openSteps: openSteps(mem.steps),
    hasPlan: mem.planPath !== undefined,
  }
  if (!shouldAutoHandoff(facts)) return
  // Claimed before the awaits, so a refresh running alongside cannot submit a second one.
  mem.handoffArmed = false
  const [agents, box] = await Promise.all([$.agent.list().catch(() => []), $.prompt.read()])
  const isIdle = !mem.isTurnRunning && !agents.some(one => one.status === 'running' || one.status === 'pending')
  if (!shouldAutoHandoff({ ...facts, isIdle, isPromptEmpty: box.text.trim() === '' })) {
    mem.handoffArmed = true
    return
  }
  mem.handoff = { tokens: warm.tokens, model: warm.model }
  const sent = await $.prompt.submit({ text: HANDOFF_PROMPT }).catch(() => undefined)
  mem.handoff = pendingAfter(mem.handoff, { kind: 'submitted', isDropped: sent === undefined || sent.drop !== undefined })
}

/** Every slash command, or none when the engine can't say. */
const listCommands = ($: $) => $.command.list().catch(() => [])

/** `names`: what to show for a key; `owners`: the plugin key behind a plugin-shipped server's key; `commands`: the plugin key behind a slash command. */
type Loaded = { keys: ItemKey[]; names: Record<ItemKey, string>; owners: Record<ItemKey, ItemKey>; commands: Record<string, ItemKey>; plugins: string[] }

// What is loaded changes only on /mcp, /plugin or a reload, so a minute-old answer serves a pane that redraws often.
const LOADED_TTL_MS = 60_000

/** MCP servers and plugins loaded now whose use the mod can see: plugins that serve a command, a skill or an MCP server. */
async function loadedItems($: $): Promise<Loaded> {
  const now = await nowOf($)
  if (mem.loaded !== undefined && now - mem.loaded.at < LOADED_TTL_MS) return mem.loaded.value
  const value = fetchLoaded($)
  mem.loaded = { at: now, value }
  // A failed fetch is not kept: the next caller tries again.
  value.catch(() => (mem.loaded?.value === value ? (mem.loaded = undefined) : undefined))
  return value
}

/** What was last loaded, however old, for hot paths that only need the plugin list or command names. */
const cachedLoaded = ($: $) => mem.loaded?.value ?? loadedItems($)

async function fetchLoaded($: $): Promise<Loaded> {
  const [tools, settings, list] = await Promise.all([$.tool.list().catch(() => []), $.settings.read().catch(() => ({}) as Record<string, unknown>), listCommands($)])
  const enabled = settings.enabledPlugins
  const ids = Object.entries(typeof enabled === 'object' && enabled !== null ? enabled : {})
    .filter(([id, isOn]) => isOn === true && pluginName(id) !== $.plugin.name)
    .map(([id]) => id)
  const plugins = ids.map(pluginName)
  const commands: Record<string, ItemKey> = {}
  for (const info of list) {
    const key = itemOfCommand(info)
    if (key !== undefined) commands[info.name] = key
  }
  const seen = new Set(Object.values(commands))
  const allMcp = tools.filter(one => one.mcp).map(one => one.name)
  const keys = new Set(connectedServers(allMcp))
  const names: Record<ItemKey, string> = {}
  const owners: Record<ItemKey, ItemKey> = {}
  for (const tool of allMcp) {
    const key = itemOfToolCall(tool, {})
    const hit = key !== undefined && keys.has(key) ? pluginServer(tool, plugins) : undefined
    if (key === undefined || hit === undefined) continue
    owners[key] = pluginKey(hit.plugin)
    names[key] = `plugin:${hit.plugin}:${hit.server}`
    seen.add(owners[key])
  }
  for (const id of ids) {
    if (!seen.has(pluginKey(id))) continue
    keys.add(pluginKey(id))
    names[pluginKey(id)] = id
  }
  return { keys: [...keys], names, owners, commands, plugins }
}

function noteUse(key: ItemKey, at: number, calls: number) {
  const was = mem.kept.used[key]
  mem.kept.used[key] = { calls: (was?.calls ?? 0) + calls, lastUsed: Math.max(was?.lastUsed ?? at, at) }
}

/** The MCP server and plugin a tool use counts toward, if any. */
async function itemsOfToolUse($: $, tool: string, input: Record<string, unknown>): Promise<ItemKey[]> {
  const direct = itemOfToolCall(tool, input)
  if (direct === undefined) return []
  const owner = direct.startsWith('mcp:plugin_') ? pluginOfMcpTool(tool, (await cachedLoaded($)).plugins) : undefined
  return owner === undefined ? [direct] : [direct, owner]
}

/** Counts a finished tool call toward the MCP server or plugin behind it, and notes work being wrapped up, planned, tracked or explored. */
async function noteToolCall($: $, e: Args<'tool.call'>, result: unknown) {
  const input = e as unknown as Record<string, unknown>
  if (e.agentId === undefined) {
    if (e.tool === 'Bash' && typeof input.command === 'string') mem.boundary = boundaryOf(input.command) ?? mem.boundary
    mem.steps = stepsAfter(mem.steps, e.tool, input, result)
    const plan = planEventOf(e.tool, input, result)
    if (plan?.kind === 'saved') mem.planPath = plan.path
    if (plan?.kind === 'work') mem.planPath = undefined
    const explored = exploredTokens(e.tool, result)
    if (explored > 0) {
      mem.explored += explored
      void noteExploration($).catch(() => undefined)
    }
  }
  const items = await itemsOfToolUse($, e.tool, input)
  if (items.length === 0) return
  const at = await nowOf($)
  for (const key of items) noteUse(key, at, 1)
  // Kept for a reload without holding up the tool's result.
  void carry($).catch(() => undefined)
}

/** The first time reads and searches fill the main context this session, learn mode explains subagents. */
async function noteExploration($: $) {
  if (mem.isExploreTaught || mem.explored < EXPLORE_MIN || !(await read($, config)).isLearning) return
  const total = (await $.session.usage()).context.tokens ?? 0
  if (!isExplorationHeavy(mem.explored, total)) return
  mem.isExploreTaught = true
  mem.pendingLessons.push(lessonFromExploration(mem.explored, total))
}

/** What a fresh context forgets; open steps and a saved handoff outlive a compaction, as Claude Code's own todo list does. */
function resetSignals(isClear: boolean) {
  if (isClear) {
    mem.steps = NO_STEPS
    mem.handoffPath = undefined
    mem.handoff = pendingAfter(mem.handoff, { kind: 'fresh-context' })
  }
  mem.planPath = undefined
  mem.corrections = 0
  mem.explored = 0
  mem.isExploreTaught = false
}

const signalFacts = () => ({
  openSteps: openSteps(mem.steps),
  planPath: tildePath(mem.planPath, mem.home),
  corrections: mem.corrections,
  hasHandoffSkill: mem.hasHandoffSkill,
  handoffPath: tildePath(mem.handoffPath, mem.home),
})

async function noteCommand($: $, name: string) {
  const key = (await cachedLoaded($)).commands[name]
  if (key === undefined) return
  noteUse(key, await nowOf($), 1)
  void carry($).catch(() => undefined)
}

/** Backfills a resumed transcript: its calls only move `lastUsed`, since the session that made them counted them. */
async function backfillUsage($: $) {
  const [now, messages] = await Promise.all([nowOf($), $.session.messages().catch(() => [])])
  for (const message of messages) for (const use of message.toolUses) for (const key of await itemsOfToolUse($, use.tool, use.input)) noteUse(key, now, 0)
  await carry($)
}

/**
 * Saves what this session used, merged with what other sessions stored. A
 * session's loaded items are taken at its first save after a prompt, when
 * slow MCP servers have connected; a session with no prompt is not counted.
 */
async function flushUsage($: $, canCount: boolean) {
  const isNewSession = canCount && mem.kept.isUncounted
  if (!isNewSession && Object.keys(mem.kept.used).length === 0) return
  // Taken fresh: a list cached at session start may predate the MCP servers that connect late.
  if (isNewSession) mem.loaded = undefined
  const [stored, now, loaded] = await Promise.all([load($, STORE.toolUse), nowOf($), isNewSession ? loadedItems($) : undefined])
  if (stored === UNREADABLE) return
  const used = mem.kept.used
  mem.kept = { ...mem.kept, used: {}, isUncounted: mem.kept.isUncounted && !isNewSession }
  const next = applyUsage(sanitizeUsage(stored), mem.repo, { at: now, isNewSession, seen: loaded?.keys ?? [], used })
  const isSaved = await $.store.set(STORE.toolUse, next).then(() => true, () => false)
  if (isSaved) {
    mem.savedUsage = { at: now, value: next }
  } else {
    // Not saved, so not lost: the calls and the uncounted session wait for the next save.
    for (const [key, use] of Object.entries(used)) noteUse(key, use.lastUsed, use.calls)
    if (isNewSession) mem.kept = { ...mem.kept, isUncounted: true }
  }
  await carry($)
}

/** The usage every session has saved, re-read at most once a minute: other sessions save too, but a pane redraws far more often. */
async function savedUsage($: $): Promise<UsageStore> {
  const now = await nowOf($)
  if (mem.savedUsage !== undefined && now - mem.savedUsage.at < LOADED_TTL_MS) return mem.savedUsage.value
  const stored = await load($, STORE.toolUse)
  const value = stored === UNREADABLE ? {} : sanitizeUsage(stored)
  if (stored !== UNREADABLE) mem.savedUsage = { at: now, value }
  return value
}

/** Idle MCP servers and plugins in this repo, counting this session's calls not yet saved, with what is loaded and this repo's saved usage. */
async function idleHere($: $) {
  const [saved, loaded, now] = await Promise.all([savedUsage($), loadedItems($), nowOf($)])
  const store = applyUsage(saved, mem.repo, { at: now, isNewSession: false, seen: [], used: mem.kept.used })
  return { idle: idleItems(store, mem.repo, loaded.keys, now, { patience: mem.patience, owners: loaded.owners }), loaded, repo: saved[mem.repo] }
}

/** Names to show: what the mod worked out, over the /mcp names of servers /context lists. */
const withServerNames = (names: Record<ItemKey, string>, servers: readonly { serverName: string }[]) => ({
  ...Object.fromEntries(servers.map(one => [mcpKey(one.serverName), one.serverName])),
  ...names,
})

/** `/route unused`: every idle MCP server and plugin here, or why nothing is listed yet. */
async function unusedReport($: $): Promise<string> {
  const [breakdown, { idle, loaded, repo }] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined),
    idleHere($),
  ])
  const here = printable(mem.repo)
  const patience = `${patienceText(mem.patience)}${mem.patience === DEV_PATIENCE ? ' (MODEL_ROUTER_IDLE_DEV)' : ''}`
  if (repo === undefined) return `No usage recorded for ${here} yet. model-router notes which MCP servers and plugins each repo uses; idle ones show here after ${patience}.`
  if (idle.length === 0) {
    return `Nothing idle in ${here}: every MCP server and plugin loaded here was used in the last 30 days, or has been loaded for under ${patience} (${plural(repo.sessions, 'session')} recorded).`
  }
  const lines = idleReport(idle, withServerNames(loaded.names, breakdown?.mcpTools ?? []), loaded.keys)
  return [`Unused in ${here} (${plural(repo.sessions, 'session')} recorded):`, ...lines.map(line => `  ${line}`)].join('\n')
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
  const meta = mem.kept.current
  if (meta === undefined) return
  mem.kept = { ...mem.kept, current: undefined }
  await carry($)
  if (p === null || p.usd <= 0) return
  const rec = recordOf(meta, p)
  await setHistory($, all => [...all, rec].slice(-HISTORY_LIMIT))
}

async function renderLastPane($: $, e: Args<'ui.render'>) {
  const [p, cfg] = await Promise.all([read($, promptCost), read($, config)])
  return lastPaneView($.ui.resolve(e), p, cfg.cacheTtlMinutes)
}

const openPane = ($: $): Open => pane => {
  if (pane === 'learn') void markLessonsRead($).catch(() => undefined)
  void $.ui.open(PANES[pane])
}

async function renderLearnPane($: $, e: Args<'ui.render'>) {
  const [cfg, all, expanded, rows, scope] = await Promise.all([read($, config), read($, lessons), read($, learnOpen), read($, learnRows), read($, learnScope)])
  return learnPaneView($.ui.resolve(e), { lessons: all, isLearning: cfg.isLearning, muted: cfg.learnMuted, expanded, rows, scope, repo: mem.repo }, {
    setLearning: isOn => void setLearning($, isOn),
    setMuted: (kind, isMuted) => void setMuted($, kind, isMuted),
    toggle: kind => void update($, learnOpen, open => (open.includes(kind) ? open.filter(one => one !== kind) : [...open, kind])),
    toggleRow: id => void update($, learnRows, open => (open.includes(id) ? open.filter(one => one !== id) : [...open, id])),
    setScope: async next => {
      await save($, STORE.learnScope, await update($, learnScope, () => next))
      await markLessonsRead($)
    },
  })
}

/** Saved history plus the prompt still running, every repo; the Stats pane narrows it to one. */
async function allRecords($: $): Promise<{ records: PromptRecord[]; now: number }> {
  const [saved, live, now] = await Promise.all([read($, history), read($, promptCost), nowOf($)])
  const current = mem.kept.current
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
  const [cfg, now, pending, costs, hp, kept, readAt, scope] = await Promise.all([
    read($, config),
    read($, active),
    read($, draft),
    read($, spend),
    read($, health),
    read($, lessons),
    read($, lessonsReadAt),
    read($, learnScope),
  ])
  const learnUnread = cfg.isLearning ? unreadCount(inScope(kept, scope), readAt, cfg.learnMuted) : 0
  const data = { cfg, now, pending, total: sumUsd(Object.values(costs)), health: hp, learnUnread }
  return bandView($.ui.resolve(e), data, { open: openPane($), hide: () => void setBand($, false) })
}

async function renderCtxPane($: $, e: Args<'ui.render'>) {
  if (e.surface === 'mobile') return contextMobileView($.ui.resolve(e))
  const columns = (e.component === 'Pane' ? e.props.bodyColumns : undefined) || 80
  const [{ context }, hp, cfg, { idle, loaded }] = await Promise.all([$.session.usage({ breakdown: 'summary', columns }), read($, health), read($, config), idleHere($)])
  const b = context.breakdown
  const servers = b?.mcpTools ?? []
  // Worked out from this breakdown, not the band's last refresh, so it holds before the first request and right after a /clear.
  const advice = b && cfg.showNext && adviseSession({
    tokens: b.totalTokens,
    window: b.rawMaxTokens,
    compactAt: b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined,
    model: hp === null ? b.model : await routedMainModel($, cfg, b.model),
    ttlMinutes: cfg.cacheTtlMinutes,
    warmMinutes: hp?.warmMinutes ?? cfg.cacheTtlMinutes,
    messagesShare: b.totalTokens > 0 ? messagesOf(b) / b.totalTokens : undefined,
    boundary: mem.boundary,
    ...signalFacts(),
  })
  const data = { breakdown: b, isTerminal: e.surface === 'terminal', columns, advice: advice || undefined, explored: mem.explored, idle: idleTips(idle, withServerNames(loaded.names, servers), tokensByServer(servers)) }
  return contextPaneView($.ui.resolve(e), data)
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
    setLearning: isOn => void setLearning($, isOn),
    setAutoHandoff: isOn => void setAutoHandoff($, isOn),
    setShowNext: isOn => void setShowNext($, isOn),
    openLearn: () => openPane($)('learn'),
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

/** The cold guard's line: the price, what happens next, and with learn mode on, why. */
const guardText = (cfg: RouterConfig, cold: { text: string }, tail: string) =>
  `model-router: ${cold.text} ${tail}${cfg.isLearning && !cfg.learnMuted.includes('cold-rewrite') ? `\n\nWhy: ${CONCEPTS['cold-rewrite'].body}` : ''}`

const LEARN_ON_TEXT =
  'Learn mode on: when a cache rewrite, a pricey model, a growing context or busy subagents cost you, a toast explains it with the numbers. /route learn lists them.'

const handoffOnText = (repo: string) =>
  `Auto-handoff on: when the cache is about to go cold with steps open or a plan not yet started, model-router asks Claude for a handoff while the cache is still warm and saves it under ~/${HANDOFF_DIR}/${segment(repo)}/. It runs once per prompt and never clears the session itself.`

const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

const USAGE = '[stats [clear | text on|off] | context | last | learn [on|off | mute|unmute <topic>] | handoff on|off | next on|off | away | unused | preset <name> | set <route> <model> [effort] | on | off | band on|off | guard refuse|warn|off | ttl 5|60]'

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
  // Lessons the running main-loop turn has taught so far; kept or dropped when it ends.
  pendingLessons: [] as LessonDraft[],
  messagesShare: undefined as number | undefined,
  // Work wrapped up (a commit, a PR) since the person last prompted.
  boundary: undefined as Boundary | undefined,
  // Todos and tasks open, a plan on disk with no other edit since, correcting prompts in a row, and read/search tokens since the last fresh context.
  steps: NO_STEPS as Steps,
  planPath: undefined as string | undefined,
  corrections: 0,
  explored: 0,
  isExploreTaught: false,
  hasHandoffSkill: false,
  home: undefined as string | undefined,
  // An auto-handoff saved since the person last prompted, and whether one may still run before they prompt again.
  handoffPath: undefined as string | undefined,
  handoffArmed: false,
  isTurnRunning: false,
  // The auto-handoff asked for and not yet answered: its turn once it starts, and the context it would have rewritten cold.
  handoff: undefined as PendingHandoff,
  // MCP servers and plugins used since the last save, whether this session has been counted yet, and what is loaded.
  kept: { used: {}, isUncounted: true } as Carried,
  loaded: undefined as { at: number; value: Promise<Loaded> } | undefined,
  savedUsage: undefined as { at: number; value: UsageStore } | undefined,
  // MODEL_ROUTER_IDLE_DEV=1: report idle items after one counted session instead of two weeks and ten.
  patience: PATIENCE as Patience,
}

async function routeOfAgent($: $, agentId: string): Promise<string | undefined> {
  const known = mem.agents.get(agentId)
  if (known !== undefined) return known.route
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed !== undefined) {
    const route = listed.teammateId !== undefined ? 'teammate' : listed.type === FORK ? FORK : `sub:${printable(listed.type)}`
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
    if (isMain && rewrite !== undefined && s.cfg.isLearning) {
      const draft = lessonFromRewrite(rewrite, {
        model: usage.model,
        ttlMinutes: ttl,
        idleMs: mem.lastMain === undefined ? undefined : stepAt - mem.lastMain.at,
        from: mem.lastMain,
        to: { model: usage.model, effort: s.effort },
      })
      if (draft !== undefined) mem.pendingLessons.push(draft)
    }
    await update($, spend, all => ({ ...all, [key]: addSpend(all[key] ?? EMPTY_SPEND, usage, usage.model, ttl) }))
    const promptAt = isMain ? undefined : mem.agents.get(agentId)?.promptAt
    if (promptAt !== undefined && promptAt !== mem.kept.current?.at) {
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
    const [stored, saved, scope, band, learned, repo, storedLessons, readAt, lessonScope] = await Promise.all([
      load($, STORE.config),
      load($, STORE.history),
      load($, STORE.statsScope),
      load($, STORE.bandShown),
      load($, STORE.modelCommands),
      $.session.repo().catch(() => null),
      load($, STORE.lessons),
      load($, STORE.lessonsReadAt),
      load($, STORE.learnScope),
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
    if (storedLessons !== UNREADABLE) await update($, lessons, () => sanitizeLessons(storedLessons))
    if (typeof readAt === 'number') await update($, lessonsReadAt, () => readAt)
    if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
    if (lessonScope === 'repo' || lessonScope === 'all') await update($, learnScope, () => lessonScope)
    if (typeof band === 'boolean') await update($, isBandShown, () => band)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    mem.repo = printable(repo?.name ?? (root.split('/').pop() || 'unknown'))
    // The same session starting again, after a hot reload of this code or a /login, keeps its running prompt, count and unsaved calls.
    const [sessionId, before, idleDev, home, commands] = await Promise.all([
      $.session.id().catch(() => undefined),
      read($, carried),
      $.env.get('MODEL_ROUTER_IDLE_DEV').catch(() => undefined),
      $.env.get('HOME').catch(() => undefined),
      listCommands($),
    ])
    mem.home = home
    mem.hasHandoffSkill = hasHandoffCommand(commands.map(one => one.name))
    const isSame = sessionId !== undefined && before?.sessionId === sessionId
    // A copy: noteUse writes into `used`, and the atom's own value is not ours to change in place.
    mem.kept = isSame ? { ...before, used: { ...before.used } } : { sessionId, used: {}, isUncounted: true }
    if (!isSame) await carry($)
    mem.loaded = undefined
    mem.savedUsage = undefined
    mem.patience = idleDev === '1' ? DEV_PATIENCE : PATIENCE
    void backfillUsage($).catch(() => undefined)
    $.ui.status(undefined)
    await refreshStatus($).catch(() => undefined)
    mem.tick?.cancel()
    mem.tick = $.clock.every(60_000, () => void refreshStatus($).catch(() => undefined))
    await $.command.register({ name: 'route', description: 'Model router: open the pane, or one of the verbs', argumentHint: USAGE })
    return next(e)
  })

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

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) await noteToolCall($, e, ran.result).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const before = (await read($, config)).isLearning ? await read($, lastUsage) : undefined
    const done = await next(e)
    if (e.agentId === undefined) {
      mem.isAfterCompact = true
      mem.boundary = undefined
      resetSignals(false)
      if (before !== undefined) mem.pendingLessons.push(lessonFromCompact(before === null ? 0 : promptTokens(before)))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const route = routeForSpawn(e)
    const { model } = resolve(await read($, config), route)
    const canRewrite = route !== FORK && e.workflow === undefined
    const started = await next(canRewrite && model ? { ...e, model } : e)
    if (started.agentId !== undefined) {
      mem.agents.set(started.agentId, { route, label: printable(`${e.subagentType} · ${e.description}`), promptAt: mem.kept.current?.at })
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
        if (cold !== undefined && guard === 'warn') $.ui.log(guardText(cfg, cold, 'Sending anyway.'))
        if (cold !== undefined && guard === 'refuse' && mem.coldAckedAt !== cold.at) {
          mem.coldAckedAt = cold.at
          return { drop: guardText(cfg, cold, 'Send it again to pay it, or /clear and start from a note.') }
        }
      }
      if (USER_ORIGINS.has(e.origin.kind)) {
        mem.handoff = pendingAfter(mem.handoff, { kind: 'user-prompt' })
        mem.handoffArmed = true
        mem.handoffPath = undefined
      }
      mem.pendingPrompt = commandLabel(e.text)
      if (!e.text.trimStart().startsWith('/')) mem.lastCommand = undefined
    }
    if (USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) mem.corrections = isCorrection(e.text) ? mem.corrections + 1 : 0
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command === 'route') return next(e)
    await noteCommand($, e.command).catch(() => undefined)
    const cfg = await read($, config)
    if (cfg.coldGuard !== 'off' && USER_ORIGINS.has(e.origin.kind)) {
      const cold = await coldSend($, cfg).catch(() => undefined)
      if (cold !== undefined && (await reachesModel($, e.command))) {
        if (cfg.coldGuard === 'warn') $.ui.log(guardText(cfg, cold, `Running /${e.command} anyway.`))
        else if (mem.coldAckedAt !== cold.at) {
          mem.coldAckedAt = cold.at
          return { text: guardText(cfg, cold, `Run /${e.command} again to pay it, or /clear and start from a note.`) }
        }
      }
    }
    mem.pendingPrompt = `/${e.command}`
    mem.lastCommand = e.command
    const done = await next(e)
    if (e.command === 'clear') {
      mem.boundary = undefined
      resetSignals(true)
      await refreshStatus($).catch(() => undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // One short time limit covers every session.end hook, so both saves run at once.
    await Promise.all([recordPrompt($).catch(() => undefined), flushUsage($, false).catch(() => undefined)])
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    mem.isTurnRunning = true
    if (mem.lastCommand !== undefined) {
      const name = mem.lastCommand
      mem.lastCommand = undefined
      await learnModelCommand($, name).catch(() => undefined)
    }
    const [cfg, route] = await Promise.all([read($, config), mainRoute($)])
    // The auto-handoff's own submit never reaches this plugin's prompt.submit hook, so its turn is told by its text.
    if (mem.handoff !== undefined && mem.handoff.turnId === undefined && e.text.includes(HANDOFF_PROMPT)) {
      mem.handoff = { ...mem.handoff, turnId: e.turnId }
      mem.pendingPrompt = HANDOFF_LABEL
    }
    if (mem.pendingPrompt !== undefined) {
      const label = mem.pendingPrompt
      mem.pendingPrompt = undefined
      mem.boundary = undefined
      await recordPrompt($).catch(() => undefined)
      const [at, sessionId] = await Promise.all([nowOf($), $.session.id().catch(() => mem.kept.sessionId)])
      // A /clear starts a new session without a session.start: count it, and let a reload recognise it.
      const isNew = sessionId !== mem.kept.sessionId
      const current = { label, text: cfg.keepPromptText ? printable(typedText(e.text).slice(0, 120)) : '', at }
      mem.kept = { ...mem.kept, current, ...(isNew ? { sessionId, isUncounted: true } : {}) }
      // Plan approval's "clear context" and /resume change the session without a /clear.
      if (isNew) resetSignals(true)
      await carry($)
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

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      mem.isTurnRunning = false
      await finishHandoff($, e).catch(() => undefined)
      await flushLessons($).catch(() => undefined)
      await flushUsage($, true).catch(() => undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb = 'route', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (Object.hasOwn(PANES, verb) && rest.length === 0) {
      const pane = verb as keyof typeof PANES
      openPane($)(pane)
      return { text: `${PANES[pane].title} pane opened.` }
    }
    if (verb === 'away') return { text: await awayReport($) }
    if (verb === 'unused') return { text: await unusedReport($) }
    if (!USER_ORIGINS.has(e.origin.kind)) return { text: `model-router: /route ${verb} only runs when you type it.` }
    if (verb === 'learn' && (rest[0] === 'on' || rest[0] === 'off')) {
      const isOn = rest[0] === 'on'
      await setLearning($, isOn)
      return { text: isOn ? LEARN_ON_TEXT : 'Learn mode off. Lessons already kept stay in /route learn.' }
    }
    if (verb === 'learn' && (rest[0] === 'mute' || rest[0] === 'unmute')) {
      const kind = rest[1]
      if (!isLessonKind(kind)) return { text: `Usage: /route learn mute|unmute <topic>, topics: ${TOPICS.join(', ')}` }
      const isMuted = rest[0] === 'mute'
      await setMuted($, kind, isMuted)
      const title = CONCEPTS[kind].title
      return { text: isMuted ? `Learn mode stays quiet about "${title}" now. /route learn unmute ${kind} brings it back.` : `Learn mode explains "${title}" again.` }
    }
    if (verb === 'stats' && rest[0] === 'clear') {
      await setHistory($, () => [])
      return { text: 'Prompt history cleared.' }
    }
    if (verb === 'stats' && rest[0] === 'text' && (rest[1] === 'on' || rest[1] === 'off')) {
      const keep = rest[1] === 'on'
      await setConfig($, c => ({ ...c, keepPromptText: keep }))
      if (keep) return { text: 'Stats keeps the first 120 characters of each prompt again.' }
      if (mem.kept.current) mem.kept = { ...mem.kept, current: { ...mem.kept.current, text: '' } }
      await carry($)
      await setHistory($, withoutText)
      return { text: 'Stats keeps only labels and costs now; saved prompt text was removed.' }
    }
    if (verb === 'ttl') {
      const minutes = Number(rest[0])
      if (minutes !== 5 && minutes !== 60) return { text: 'Usage: /route ttl 5|60 (prompt-cache lifetime in minutes)' }
      await setConfig($, c => ({ ...c, cacheTtlMinutes: minutes }))
      return { text: `Cache lifetime set to ${minutes} minutes.` }
    }
    if (verb === 'next') {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route next on|off (show next /clear, /compact or /handoff when carrying on is not the best move)' }
      const isOn = rest[0] === 'on'
      await setShowNext($, isOn)
      return { text: isOn ? 'Next-step advice on: the band shows next /clear, /compact or /handoff when carrying on is not the best move, with the reason in the Context pane.' : 'Next-step advice off: the band and the Context pane no longer suggest when to clear, compact or hand off.' }
    }
    if (verb === 'handoff') {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route handoff on|off (save a handoff while the cache is still warm, before it goes cold with work open)' }
      const isOn = rest[0] === 'on'
      await setAutoHandoff($, isOn)
      return { text: isOn ? handoffOnText(mem.repo) : 'Auto-handoff off.' }
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

  on('ui.render', { component: 'Pane', requestId: PANES.learn.id }, ($, e) => renderLearnPane($, e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode') return next(e)
    return renderStatsFooter($, e, e.props.modes)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)
    return renderBand($, e)
  })
}
