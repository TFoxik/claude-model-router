import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveRoute, Carried, ColdGuard, CostTab, Effort, Health, LastUsage, Lesson, LessonKind, PromptCost, PromptRecord, RouteSpend, RouterConfig, Scope } from '../types'
import {
  CONCEPTS,
  TOAST_MS,
  TOPICS,
  awayOptions,
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
import type { AwayFacts, LessonDraft } from './lessons'
import {
  AUTO_LABELS,
  CACHE_TTLS,
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
import { HANDOFF_DIR, HANDOFF_LABEL, HANDOFF_PROMPT, handoffPath, isAgentBusy, pendingAfter, segment, shouldAutoHandoff, tildePath } from './handoff'
import type { PendingHandoff } from './handoff'
import { bandCount, closeMarked, handoffDir, handoffRows, handoffsRoot, mergeListing, recordWritten, reopen, repoOfHandoff, resumeIn, sanitizeHandoffs, setStatus, detailsOf, withDetails } from './handoffs'
import type { HandoffStatus, Handoffs } from './handoffs'
import { EXPLORE_MIN, NO_STEPS, exploredTokens, hasHandoffCommand, isCorrection, isExplorationHeavy, openSteps, planEventOf, stepsAfter } from './signals'
import type { Steps } from './signals'
import { adviseSession, boundaryOf } from './strategy'
import type { Boundary } from './strategy'
import { messagesOf, tokensByServer } from './tips'
import type { TipAction } from './tips'
import { DEV_PATIENCE, PATIENCE, applyUsage, claudeAiKey, claudeAiReport, claudeAiTips, connectedServers, connectorAliases, idleItems, idleReport, idleTips, itemOfCommand, itemOfToolCall, listingTokens, mcpKey, mergeAliases, onlyHere, patienceText, pluginKey, pluginName, pluginOfMcpTool, pluginServer, sanitizeAliases, sanitizeUsage, skillKey, skillReport, skillTips, sourcesOfLock, syncedSkillNames } from './usage'
import type { ItemKey, OwnSkill, Patience, UsageStore } from './usage'
import { bandView } from './ui/band'
import { contextMobileView, contextPaneView } from './ui/context-pane'
import { COST_TAB_LABEL, OLD_COST_IDS, PANES, isTarget, paneOf } from './ui/kit'
import type { Open, Target } from './ui/kit'
import { costPaneView } from './ui/cost-pane'
import { handoffsPaneView } from './ui/handoffs-pane'
import { learnPaneView } from './ui/learn-pane'
import { routesMobileView, routesPaneView } from './ui/routes-pane'
import { statsFooterView } from './ui/stats'

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
const costTab = atom({ plugin: 'model-router', key: 'costTab' } as const, 'last' as CostTab)
const promptCost = atom({ plugin: 'model-router', key: 'promptCost' } as const, null as PromptCost | null)
const isBandShown = atom({ plugin: 'model-router', key: 'isBandShown' } as const, true)
const lessons = atom({ plugin: 'model-router', key: 'lessons' } as const, [] as Lesson[])
const lessonsReadAt = atom({ plugin: 'model-router', key: 'lessonsReadAt' } as const, 0)
const learnOpen = atom({ plugin: 'model-router', key: 'learnOpen' } as const, [] as LessonKind[])
const learnRows = atom({ plugin: 'model-router', key: 'learnRows' } as const, [] as string[])
const learnScope = atom({ plugin: 'model-router', key: 'learnScope' } as const, 'repo' as Scope)
const handoffs = atom({ plugin: 'model-router', key: 'handoffs' } as const, {} as Handoffs)
const handoffScope = atom({ plugin: 'model-router', key: 'handoffScope' } as const, 'repo' as Scope)
const handoffClosedShown = atom({ plugin: 'model-router', key: 'handoffClosedShown' } as const, false)
// Atoms outlive a hot reload of this code and `mem` does not: this keeps what the session would lose with it.
const carried = atom({ plugin: 'model-router', key: 'carried' } as const, null as Carried | null)

type $ = EngineInterface

// The store keys the atoms kept across sessions are saved under. The engine's
// scan needs each update() to name its atom, so callers update, then save().
const STORE = { config: 'config', history: 'history', statsScope: 'statsScope', bandShown: 'bandShown', modelCommands: 'modelCommands', lessons: 'lessons', lessonsReadAt: 'lessonsReadAt', learnScope: 'learnScope', toolUse: 'toolUse', connectorNames: 'connectorNames', handoffs: 'handoffs', handoffScope: 'handoffScope' } as const

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

/** One at a time: two overlapping edits would both start from the same stored value, and the later save would drop the earlier. */
function setHandoffs($: $, fn: (all: Handoffs) => Handoffs): Promise<Handoffs> {
  const run = mem.handoffsChain.then(() => applyHandoffs($, fn))
  mem.handoffsChain = run.catch(() => undefined)
  return run
}

/** An edit that returns the records it was given changes nothing, so nothing is saved. */
async function applyHandoffs($: $, fn: (all: Handoffs) => Handoffs): Promise<Handoffs> {
  const stored = await load($, STORE.handoffs)
  let isChanged = false
  const next = await update($, handoffs, all => {
    const base = stored === UNREADABLE || stored === undefined ? all : sanitizeHandoffs(stored)
    const edited = fn(base)
    isChanged = edited !== base
    return edited
  })
  if (isChanged && stored !== UNREADABLE) await save($, STORE.handoffs, next)
  return next
}

/** Without the text, title and gist are left for the next listing to read from the file. */
async function recordHandoff($: $, path: string, repo: string, text: string | undefined) {
  const [at, sessionId] = [await nowOf($), mem.kept.sessionId]
  const details = text === undefined ? {} : detailsOf(text)
  await setHandoffs($, all => recordWritten(all, path, { repo, at, ...(sessionId === undefined ? {} : { sessionId }), ...details })).catch(() => undefined)
}

type Listed = { path: string; mtimeMs: number }[]

/** A folder's handoff files, and the mtime of each `.md.closed` marker by the handoff it closes; empty when the folder doesn't exist, `undefined` when it couldn't be read. */
async function listHandoffs($: $, dir: string): Promise<{ files: Listed; markers: Record<string, number> } | undefined> {
  try {
    if (!(await $.fs.exists(dir))) return { files: [], markers: {} }
    const entries = (await $.fs.list(dir)).filter(one => one.kind === 'file')
    const files = entries.filter(one => one.name.endsWith('.md')).map(one => ({ path: `${dir}/${one.name}`, mtimeMs: one.mtimeMs }))
    const markers = Object.fromEntries(entries.filter(one => one.name.endsWith('.md.closed')).map(one => [`${dir}/${one.name.slice(0, -'.closed'.length)}`, one.mtimeMs]))
    return { files, markers }
  } catch {
    return undefined
  }
}

/** Brings the records in line with the folder on disk, and reads the details of files not read yet or changed since. */
async function refreshHandoffs($: $, scope?: Scope) {
  const home = mem.home
  if (home === undefined) return
  const inScope = scope ?? (await read($, handoffScope))
  const repos = inScope === 'repo' ? [segment(mem.repo)] : ((await $.fs.list(handoffsRoot(home)).catch(() => undefined))?.filter(one => one.kind === 'dir').map(one => one.name) ?? [])
  const listedAt = await nowOf($)
  const lists = await Promise.all(repos.map(repo => listHandoffs($, handoffDir(home, repo))))
  const listing: Record<string, Listed> = Object.fromEntries(repos.flatMap((repo, i) => (lists[i] === undefined ? [] : [[repo, lists[i]!.files]])))
  const markers = Object.assign({}, ...lists.map(one => one?.markers))
  const preview = mergeListing(await read($, handoffs), listing, listedAt)
  // A file outside the listing is stamped 0, so it is read once more when a listing shows its real mtime.
  const mtimes: Record<string, number> = Object.fromEntries(Object.values(listing).flat().map(one => [one.path, one.mtimeMs]))
  const unread = Object.entries(preview).filter(([path, r]) => r.readMtimeMs === undefined || (mtimes[path] ?? 0) > r.readMtimeMs)
    .sort((a, b) => Number(b[1].status === 'open') - Number(a[1].status === 'open') || b[1].at - a[1].at).slice(0, 20)
  const found = await Promise.all(unread.map(([path]) => $.fs.read(path).then(text => detailsOf(typeof text === 'string' ? text : ''), () => detailsOf(''))))
  const details = Object.fromEntries(unread.map(([path], i) => [path, { ...found[i]!, readMtimeMs: mtimes[path] ?? 0 }]))
  await setHandoffs($, all => withDetails(closeMarked(mergeListing(all, listing, listedAt), markers), details))
}

async function renderHandoffsPane($: $, e: Args<'ui.render'>) {
  const [all, scope, isClosedShown, now, cfg] = await Promise.all([read($, handoffs), read($, handoffScope), read($, handoffClosedShown), nowOf($), read($, config)])
  const repo = segment(mem.repo)
  const { open, closed } = handoffRows(all, scope === 'repo' ? repo : undefined, now)
  const folder = mem.home === undefined ? `~/${HANDOFF_DIR}/` : tildePath(scope === 'repo' ? handoffDir(mem.home, repo) : handoffsRoot(mem.home), mem.home)
  return handoffsPaneView($.ui.resolve(e), { open, closed, isClosedShown, scope, repo, folder, isOn: cfg.isHandoffs }, {
    setOn: isOn => void setHandoffsOn($, isOn),
    resume: path => void $.prompt.fill({ text: `resume from ${tildePath(path, mem.home)}`, mode: 'replace' }).catch(() => undefined),
    setStatus: (path, status: HandoffStatus) => void setHandoffs($, records => setStatus(records, path, status)),
    reopen: path => void nowOf($).then(at => setHandoffs($, records => reopen(records, path, at))),
    toggleClosed: () => void update($, handoffClosedShown, was => !was),
    setScope: async next => {
      await save($, STORE.handoffScope, await update($, handoffScope, () => next))
      await refreshHandoffs($)
    },
  })
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
  await recordHandoff($, path, segment(mem.repo), e.answer)
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
    const { sessionId } = mem.kept
    const fresh: Lesson[] = all.map(d => ({ ...d, at: now, repo: mem.repo, ...(sessionId === undefined ? {} : { sessionId }) }))
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

async function setHandoffsOn($: $, isOn: boolean) {
  await setConfig($, c => ({ ...c, isHandoffs: isOn }))
}

async function setAutoHandoff($: $, isOn: boolean) {
  await setConfig($, c => ({ ...c, autoHandoff: isOn }))
}

async function setShowNext($: $, isOn: boolean) {
  await setConfig($, c => ({ ...c, showNext: isOn }))
}

/** Turning it off also removes the text already kept, this prompt's included. */
async function setKeepText($: $, keep: boolean) {
  await setConfig($, c => ({ ...c, keepPromptText: keep }))
  if (keep) return
  if (mem.kept.current) mem.kept = { ...mem.kept, current: { ...mem.kept.current, text: '' } }
  await carry($)
  await setHistory($, withoutText)
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

/** This session as it stands, for pricing the ways to step away; undefined before anything is cached. `tokens` saves a usage read. */
async function awayFacts($: $, cfg: RouterConfig, tokens?: number): Promise<AwayFacts | undefined> {
  const last = await read($, lastUsage)
  if (last === null) return undefined
  tokens ??= (await $.session.usage()).context.tokens ?? promptTokens(last)
  const warmMinutes = warmMinutesLeft(last.at, await nowOf($), cfg.cacheTtlMinutes)
  return { tokens, model: await routedMainModel($, cfg, last.model), ttlMinutes: cfg.cacheTtlMinutes, warmMinutes }
}

/** `/route away`: the ways to step away, priced for this session as it stands. */
async function awayReport($: $): Promise<string> {
  const facts = await awayFacts($, await read($, config))
  return facts === undefined ? 'Nothing is cached in this session yet.' : awayText(facts)
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
    isOn: cfg.isHandoffs && cfg.autoHandoff,
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
  const isIdle = !mem.isTurnRunning && !agents.some(one => isAgentBusy(one.status))
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

/**
 * `names`: what to show for a key; `owners`: the plugin key behind a plugin-shipped server's key; `commands`: the plugin or own-skill key behind a slash command;
 * `own`: your own skills and commands under ~/.claude by key, and `ownNames` the same by name;
 * `aliases`: the `claude_ai_<Name>` key of each desktop-app connector id; `synced`: claude.ai skills by every spelling a call uses, and `syncedCount` how many are loaded.
 */
type Loaded = {
  keys: ItemKey[]
  names: Record<ItemKey, string>
  owners: Record<ItemKey, ItemKey>
  commands: Record<string, ItemKey>
  plugins: string[]
  own: Record<ItemKey, OwnSkill>
  ownNames: Set<string>
  aliases: Record<ItemKey, ItemKey>
  synced: Map<string, string>
  syncedCount: number
}

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

/** Your skills (a folder or a link with a SKILL.md) and commands (`.md` files) under ~/.claude, with where the `skills` CLI installed each from. */
async function ownSkills($: $): Promise<OwnSkill[]> {
  const home = mem.home ?? (await $.env.get('HOME').catch(() => undefined))
  if (home === undefined) return []
  const [skills, commands, lock] = await Promise.all([
    $.fs.list(`${home}/.claude/skills`).catch(() => []),
    $.fs.list(`${home}/.claude/commands`).catch(() => []),
    $.fs.read(`${home}/.agents/.skill-lock.json`).then(sourcesOfLock, () => ({}) as Record<string, string>),
  ])
  const found = await Promise.all(
    skills
      .filter(one => !one.name.startsWith('.') && (one.kind === 'dir' || one.isLink))
      .map(async one =>
        (await $.fs.exists(`${home}/.claude/skills/${one.name}/SKILL.md`).catch(() => false))
          ? [{ name: one.name, kind: 'skill' as const, isLink: one.isLink, ...(lock[one.name] === undefined ? {} : { source: lock[one.name] }) }]
          : [],
      ),
  )
  const files = commands
    .filter(one => !one.name.startsWith('.') && one.name.endsWith('.md') && (one.kind === 'file' || one.isLink))
    .map(one => ({ name: one.name.slice(0, -'.md'.length), kind: 'command' as const, isLink: one.isLink }))
  return [...found.flat(), ...files]
}

/**
 * Connector names: what /context shows now, over what earlier sessions saved,
 * so an id the app no longer lists still merges into its name. Saved when
 * something new turns up.
 */
function connectorNames($: $, stored: unknown, mcpTools: ReadonlyArray<{ name: string; serverName: string }>): Record<ItemKey, ItemKey> {
  const known = stored === UNREADABLE ? {} : sanitizeAliases(stored)
  const fresh = connectorAliases(mcpTools)
  const merged = { ...known, ...fresh }
  if (stored !== UNREADABLE && Object.entries(fresh).some(([id, key]) => known[id] !== key)) void save($, STORE.connectorNames, merged)
  return merged
}

async function fetchLoaded($: $): Promise<Loaded> {
  const [tools, settings, list, ownList, breakdown, storedNames] = await Promise.all([
    $.tool.list().catch(() => []),
    $.settings.read().catch(() => ({}) as Record<string, unknown>),
    listCommands($),
    ownSkills($),
    $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined),
    load($, STORE.connectorNames),
  ])
  const aliases = connectorNames($, storedNames, breakdown?.mcpTools ?? [])
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
  const keys = new Set(connectedServers(allMcp, aliases))
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
  const own: Record<ItemKey, OwnSkill> = {}
  for (const one of ownList) {
    const key = skillKey(one.name)
    own[key] = one
    keys.add(key)
    names[key] = one.name
    commands[one.name] ??= key
  }
  const synced = syncedSkillNames(breakdown?.skills?.skillFrontmatter ?? [])
  const listed = new Set(synced.values())
  for (const name of listed) {
    keys.add(claudeAiKey(name))
    names[claudeAiKey(name)] = name
  }
  return { keys: [...keys], names, owners, commands, plugins, own, ownNames: new Set(ownList.map(one => one.name)), aliases, synced, syncedCount: listed.size }
}

function noteUse(key: ItemKey, at: number, calls: number) {
  const was = mem.kept.used[key]
  mem.kept.used[key] = { calls: (was?.calls ?? 0) + calls, lastUsed: Math.max(was?.lastUsed ?? at, at) }
}

/** The MCP server, plugin or own skill a tool use counts toward, if any. */
async function itemsOfToolUse($: $, tool: string, input: Record<string, unknown>): Promise<ItemKey[]> {
  // Only a Skill call needs the loaded names; a connector id is merged into its name when usage is saved.
  const known = tool === 'Skill' ? await cachedLoaded($) : undefined
  const direct = itemOfToolCall(tool, input, known?.ownNames, known?.synced)
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
    const written = e.tool === 'Write' && typeof input.file_path === 'string' ? input.file_path : undefined
    const handoffRepo = written === undefined ? undefined : repoOfHandoff(written, mem.home)
    if (written !== undefined && handoffRepo !== undefined) await recordHandoff($, written, handoffRepo, typeof input.content === 'string' ? input.content : undefined)
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
  const [stored, now, loaded] = await Promise.all([load($, STORE.toolUse), nowOf($), isNewSession ? loadedItems($) : mem.loaded?.value.catch(() => undefined)])
  if (stored === UNREADABLE) return
  const used = mem.kept.used
  mem.kept = { ...mem.kept, used: {}, isUncounted: mem.kept.isUncounted && !isNewSession }
  const next = applyUsage(mergeAliases(sanitizeUsage(stored), loaded?.aliases ?? {}), mem.repo, { at: now, isNewSession, seen: isNewSession ? (loaded?.keys ?? []) : [], used })
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

/** Idle MCP servers, plugins and own skills in this repo, and own skills used only here, counting this session's calls not yet saved, with what is loaded and this repo's saved usage. */
async function idleHere($: $) {
  const [saved, loaded, now] = await Promise.all([savedUsage($), loadedItems($), nowOf($)])
  const store = applyUsage(mergeAliases(saved, loaded.aliases), mem.repo, { at: now, isNewSession: false, seen: [], used: mem.kept.used })
  const idle = idleItems(store, mem.repo, loaded.keys, now, { patience: mem.patience, owners: loaded.owners })
  return { idle, only: onlyHere(store, mem.repo, Object.keys(loaded.own), now, mem.patience), loaded, repo: saved[mem.repo] }
}

/** Names to show: what the mod worked out, over the /mcp names of servers /context lists. */
const withServerNames = (names: Record<ItemKey, string>, servers: readonly { serverName: string }[]) => ({
  ...Object.fromEntries(servers.map(one => [mcpKey(one.serverName), one.serverName])),
  ...names,
})

/** `/route unused`: every idle MCP server and plugin here, or why nothing is listed yet. */
async function unusedReport($: $): Promise<string> {
  const [breakdown, { idle, only, loaded, repo }] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined),
    idleHere($),
  ])
  const here = printable(mem.repo)
  const patience = `${patienceText(mem.patience)}${mem.patience === DEV_PATIENCE ? ' (MODEL_ROUTER_IDLE_DEV)' : ''}`
  if (repo === undefined) return `No usage recorded for ${here} yet. model-router notes which MCP servers, plugins and your own skills each repo uses; idle ones show here after ${patience}.`
  const lines = [...idleReport(idle, withServerNames(loaded.names, breakdown?.mcpTools ?? []), loaded.keys), ...skillReport(idle, only, loaded.own, mem.root), ...claudeAiReport(idle, loaded.syncedCount)]
  if (lines.length === 0) {
    return `Nothing idle in ${here}: every MCP server, plugin and skill of yours loaded here was used in the last 30 days, or has been loaded for under ${patience} (${plural(repo.sessions, 'session')} recorded).`
  }
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

/** Opening an open pane only retitles it, so one open behind another is reopened to come to the front. */
async function raisePane($: $, pane: keyof typeof PANES) {
  const open = (await $.ui.panes().catch(() => [])).find(one => one.id === PANES[pane].id)
  if (open !== undefined && !open.isShown) await $.ui.close({ id: PANES[pane].id })
  await $.ui.open(PANES[pane])
}

/** What opening a pane does besides showing it. */
async function onOpen($: $, pane: keyof typeof PANES) {
  if (pane === 'learn') await markLessonsRead($)
  if (pane === 'handoffs') await refreshHandoffs($)
}

async function showPane($: $, target: Target) {
  const { pane, tab } = paneOf(target)
  if (tab !== undefined) await update($, costTab, () => tab)
  await Promise.all([onOpen($, pane).catch(() => undefined), raisePane($, pane).catch(() => undefined)])
}

const openPane = ($: $): Open => target => void showPane($, target)

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

/** Saved history plus the prompt still running, every repo; the Cost pane's History tab narrows it to one. */
async function allRecords($: $): Promise<{ records: PromptRecord[]; now: number }> {
  const [saved, live, now] = await Promise.all([read($, history), read($, promptCost), nowOf($)])
  const current = mem.kept.current
  return { records: live && current && live.usd > 0 ? [...saved, recordOf(current, live)] : saved, now }
}

async function renderStatsFooter($: $, e: Args<'ui.render'>, modes: readonly string[]) {
  const { records, now } = await allRecords($)
  return statsFooterView($.ui.resolve(e), { modes, today: todayUsd(records, now) }, { open: openPane($) })
}

async function renderCostPane($: $, e: Args<'ui.render'>) {
  const [tab, scope, lastPrompt, costs, cfg] = await Promise.all([read($, costTab), read($, statsScope), read($, promptCost), read($, spend), read($, config)])
  const { records: all, now } = tab === 'history' ? await allRecords($) : { records: [], now: 0 }
  const records = scope === 'repo' ? all.filter(r => r.repo === mem.repo) : all
  return costPaneView($.ui.resolve(e), { tab, lastPrompt, costs, records, scope, repo: mem.repo, now, ttlMinutes: cfg.cacheTtlMinutes }, {
    setTab: next => void update($, costTab, () => next),
    setScope: async next => void save($, STORE.statsScope, await update($, statsScope, () => next)),
  })
}

const setBand = async ($: $, isShown: boolean) => save($, STORE.bandShown, await update($, isBandShown, () => isShown))

async function renderBand($: $, e: Args<'ui.render'>) {
  const [cfg, now, pending, costs, hp, kept, readAt, scope, records] = await Promise.all([
    read($, config),
    read($, active),
    read($, draft),
    read($, spend),
    read($, health),
    read($, lessons),
    read($, lessonsReadAt),
    read($, learnScope),
    read($, handoffs),
  ])
  const handoffsOpen = !cfg.isHandoffs ? 0 : bandCount(records, segment(mem.repo), mem.kept.sessionId, await nowOf($))
  const learnUnread = cfg.isLearning ? unreadCount(inScope(kept, scope), readAt, cfg.learnMuted, { since: mem.kept.since ?? 0, sessionId: mem.kept.sessionId }) : 0
  const data = { cfg, now, pending, total: sumUsd(Object.values(costs)), health: hp, learnUnread, handoffsOpen }
  return bandView($.ui.resolve(e), data, { open: openPane($) })
}

async function renderCtxPane($: $, e: Args<'ui.render'>) {
  if (e.surface === 'mobile') return contextMobileView($.ui.resolve(e))
  const columns = (e.component === 'Pane' ? e.props.bodyColumns : undefined) || 80
  const [{ context }, hp, cfg, { idle, only, loaded }] = await Promise.all([$.session.usage({ breakdown: 'summary', columns }), read($, health), read($, config), idleHere($)])
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
  // Only once there is enough cached to be worth planning a break around: the cold guard's threshold.
  const facts = (context.tokens ?? 0) >= GUARD_MIN_TOKENS ? await awayFacts($, cfg, context.tokens) : undefined
  const away = facts && awayOptions(facts)
  const tokens = listingTokens(b?.skills?.skillFrontmatter ?? [])
  const tips = [...idleTips(idle, withServerNames(loaded.names, servers), tokensByServer(servers), { root: mem.root, tokens }), ...skillTips(idle, only, loaded.own, mem.root, tokens), ...claudeAiTips(idle, loaded.syncedCount, tokens)]
  const data = { breakdown: b, isTerminal: e.surface === 'terminal', columns, advice: advice || undefined, explored: mem.explored, unused: tips, away }
  const fill = (text: string) => void $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  // A menu such as /mcp opens as if typed; where the engine refuses, it is left in the prompt instead.
  const act = (action: TipAction) => (action.isSlash ? void $.command.run({ command: action.command }).catch(() => fill(`/${action.command}`)) : fill(action.command))
  return contextPaneView($.ui.resolve(e), data, { act })
}

async function renderPane($: $, e: Args<'ui.render'>) {
  const now = await read($, active)
  if (e.surface === 'mobile') return routesMobileView($.ui.resolve(e), now)
  const els = $.ui.resolve(e)
  const [cfg, costs, isPlanning, pending, lastPrompt, usage, isBand] = await Promise.all([
    read($, config),
    read($, spend),
    read($, isPlan),
    read($, draft),
    read($, promptCost),
    $.session.usage(),
    read($, isBandShown),
  ])
  const sessionModel = now?.model ?? (await $.session.model())
  const data = { cfg, total: sumUsd(Object.values(costs)), now, isPlanning, pending, lastPrompt, contextTokens: usage.context.tokens ?? 0, sessionModel, isBand }
  return routesPaneView(els, data, {
    editDraft: fn =>
      void update($, draft, d => {
        const next = fn(d ?? cfg)
        return JSON.stringify(next) === JSON.stringify(cfg) ? null : next
      }),
    toggle: () => void setConfig($, c => ({ ...c, isEnabled: !c.isEnabled })),
    setLearning: isOn => void setLearning($, isOn),
    setHandoffs: isOn => void setHandoffsOn($, isOn),
    setAutoHandoff: isOn => void setAutoHandoff($, isOn),
    setBand: isShown => void setBand($, isShown),
    openHandoffs: () => openPane($)('handoffs'),
    setShowNext: isOn => void setShowNext($, isOn),
    openLearn: () => openPane($)('learn'),
    setGuard: mode => void setConfig($, c => ({ ...c, coldGuard: mode })),
    setTtl: minutes => void setConfig($, c => ({ ...c, cacheTtlMinutes: minutes })),
    setKeepText: keep => void setKeepText($, keep),
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

const HANDOFFS_ON_TEXT = 'Handoffs on: the band counts handoffs other sessions left open, and auto-handoff runs when it is on (/route handoffs auto on|off).'
const HANDOFFS_OFF_TEXT = 'Handoffs off: no count in the band and no auto-handoff. Handoffs you save with /handoff are still listed in /route handoffs.'

const handoffOnText = (repo: string) =>
  `Auto-handoff on: when the cache is about to go cold with steps open or a plan not yet started, model-router asks Claude for a handoff while the cache is still warm and saves it under ~/${HANDOFF_DIR}/${segment(repo)}/. It runs once per prompt and never clears the session itself.`

/**
 * `/route` words in their current form: `cost <tab>` opens a tab as `<tab>` does, and
 * `handoff on|off` is the older name of `handoffs auto on|off`.
 */
function aliased(words: readonly string[]): string[] {
  const [verb, ...rest] = words
  if (verb === 'cost' && rest.length === 1) return rest
  if (verb === 'handoff') return ['handoffs', 'auto', ...rest]
  return [...words]
}

const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

const USAGE = '[cost [last|session|history] | last | stats [clear | text on|off] | context | learn [on|off | mute|unmute <topic>] | handoffs [on|off | auto on|off] | next on|off | away | unused | preset <name> | set <route> <model> [effort] | on | off | band on|off | guard refuse|warn|off | ttl 5|60]'

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
  // The repo's root, for commands a tip puts in the prompt.
  root: undefined as string | undefined,
  // An auto-handoff saved since the person last prompted, and whether one may still run before they prompt again.
  handoffPath: undefined as string | undefined,
  handoffArmed: false,
  isTurnRunning: false,
  // The auto-handoff asked for and not yet answered: its turn once it starts, and the context it would have rewritten cold.
  handoff: undefined as PendingHandoff,
  handoffsChain: Promise.resolve() as Promise<unknown>,
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
    const [stored, saved, scope, band, learned, repo, storedLessons, readAt, lessonScope, storedHandoffs, handoffScopeSaved] = await Promise.all([
      load($, STORE.config),
      load($, STORE.history),
      load($, STORE.statsScope),
      load($, STORE.bandShown),
      load($, STORE.modelCommands),
      $.session.repo().catch(() => null),
      load($, STORE.lessons),
      load($, STORE.lessonsReadAt),
      load($, STORE.learnScope),
      load($, STORE.handoffs),
      load($, STORE.handoffScope),
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
    if (storedHandoffs !== UNREADABLE) await update($, handoffs, () => sanitizeHandoffs(storedHandoffs))
    if (handoffScopeSaved === 'repo' || handoffScopeSaved === 'all') await update($, handoffScope, () => handoffScopeSaved)
    if (typeof readAt === 'number') await update($, lessonsReadAt, () => readAt)
    if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
    if (lessonScope === 'repo' || lessonScope === 'all') await update($, learnScope, () => lessonScope)
    if (typeof band === 'boolean') await update($, isBandShown, () => band)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    mem.repo = printable(repo?.name ?? (root.split('/').pop() || 'unknown'))
    mem.root = root === '' ? undefined : root
    // The same session starting again, after a hot reload of this code or a /login, keeps its running prompt, count and unsaved calls.
    const [sessionId, before, idleDev, home, commands, startedAt] = await Promise.all([
      $.session.id().catch(() => undefined),
      read($, carried),
      $.env.get('MODEL_ROUTER_IDLE_DEV').catch(() => undefined),
      $.env.get('HOME').catch(() => undefined),
      listCommands($),
      nowOf($),
    ])
    mem.home = home
    // The band only needs this repo's; the pane lists every repo when it opens under All.
    void refreshHandoffs($, 'repo').catch(() => undefined)
    mem.hasHandoffSkill = hasHandoffCommand(commands.map(one => one.name))
    const isSame = sessionId !== undefined && before?.sessionId === sessionId
    // A copy: noteUse writes into `used`, and the atom's own value is not ours to change in place.
    mem.kept = isSame ? { ...before, used: { ...before.used } } : { sessionId, used: {}, isUncounted: true, since: startedAt }
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
    let resumeText: string | undefined
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
        resumeText = e.text
      }
      mem.pendingPrompt = commandLabel(e.text)
      if (!e.text.trimStart().startsWith('/')) mem.lastCommand = undefined
    }
    if (USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) mem.corrections = isCorrection(e.text) ? mem.corrections + 1 : 0
    const out = await next(e)
    // Marked once the prompt is through: a hook further down may still drop it.
    if (resumeText !== undefined && out.drop === undefined) {
      const text = resumeText
      await setHandoffs($, all => resumeIn(all, text, mem.home)).catch(() => undefined)
    }
    return out
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
      mem.kept = { ...mem.kept, since: await nowOf($) }
      await carry($)
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
      mem.kept = { ...mem.kept, current, ...(isNew ? { sessionId, isUncounted: true, since: at } : {}) }
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
    const [verb = 'route', ...rest] = aliased(e.args.trim().split(/\s+/).filter(Boolean))
    if (rest.length === 0 && isTarget(verb)) {
      await showPane($, verb)
      const { pane, tab } = paneOf(verb)
      return { text: tab === undefined ? `${PANES[pane].title} pane opened.` : `Cost pane opened on ${COST_TAB_LABEL[tab]}.` }
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
      await setKeepText($, keep)
      return { text: keep ? 'Stats keeps the first 120 characters of each prompt again.' : 'Stats keeps only labels and costs now; saved prompt text was removed.' }
    }
    if (verb === 'ttl') {
      const minutes = Number(rest[0])
      if (!CACHE_TTLS.includes(minutes)) return { text: 'Usage: /route ttl 5|60 (prompt-cache lifetime in minutes)' }
      await setConfig($, c => ({ ...c, cacheTtlMinutes: minutes }))
      return { text: `Cache lifetime set to ${minutes} minutes.` }
    }
    if (verb === 'next') {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route next on|off (show next /clear, /compact or /handoff when carrying on is not the best move)' }
      const isOn = rest[0] === 'on'
      await setShowNext($, isOn)
      return { text: isOn ? 'Next-step advice on: the band shows next /clear, /compact or /handoff when carrying on is not the best move, with the reason in the Context pane.' : 'Next-step advice off: the band and the Context pane no longer suggest when to clear, compact or hand off.' }
    }
    if (verb === 'handoffs' && rest[0] === 'auto') {
      const autoSwitch = rest[1]
      if (autoSwitch !== 'on' && autoSwitch !== 'off') return { text: 'Usage: /route handoffs auto on|off (save a handoff while the cache is still warm, before it goes cold with work open)' }
      const isOn = autoSwitch === 'on'
      await setAutoHandoff($, isOn)
      return { text: isOn ? handoffOnText(mem.repo) : 'Auto-handoff off.' }
    }
    if (verb === 'handoffs') {
      if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route handoffs on|off (the Handoffs pane, the band\'s count and auto-handoff), /route handoffs auto on|off, or /route handoffs to open the pane' }
      const isOn = rest[0] === 'on'
      await setHandoffsOn($, isOn)
      return { text: isOn ? HANDOFFS_ON_TEXT : HANDOFFS_OFF_TEXT }
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

  on('ui.render', { component: 'Pane', requestId: PANES.context.id }, ($, e) => renderCtxPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.cost.id }, ($, e) => renderCostPane($, e))

  for (const id of OLD_COST_IDS) on('ui.render', { component: 'Pane', requestId: id }, ($, e) => renderCostPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.learn.id }, ($, e) => renderLearnPane($, e))

  on('ui.render', { component: 'Pane', requestId: PANES.handoffs.id }, ($, e) => renderHandoffsPane($, e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode') return next(e)
    return renderStatsFooter($, e, e.props.modes)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)
    return renderBand($, e)
  })
}
