import type { Args, EngineInterface } from 'claude-code'
import type { Effort, Health, LastUsage, PromptCost, PromptRecord, RouterConfig } from '../../types'
import { repoOfHandoff } from '../handoffs/records'
import { tildePath } from '../handoffs/handoff'
import { pushLesson, pushUrgent } from '../learn/drafts'
import { lessonFromAdvice, lessonFromContext, lessonFromExpiry, lessonFromExploration, lessonFromPlanToggle, lessonFromRewrite } from '../learn/lessons'
import type { AwayFacts } from '../learn/lessons'
import { FORK, resolve } from '../routing/routes'
import { fmtAge, kTokens, money, printable } from './format'
import { itemsOfToolUse, noteUse } from './items'
import { EMPTY_PROMPT, EMPTY_SPEND, HISTORY_LIMIT, addLateStep, addSpend, addStep, modelsOf, subagentCount } from './ledger'
import { GUARD_MIN_TOKENS, coldForMs, contextLevel, costOf, labelOf, rewriteCause, rewriteOf, rewritePrice, warmMinutesLeft } from './pricing'
import { session } from './session'
import { EXPLORE_MIN, NO_STEPS, boundaryOf, editsAfter, exploredTokens, isExplorationHeavy, openSteps, planEventOf, stepsAfter } from './signals'
import { carry, configOf, healthOf, historyOf, isPlanOf, lastUsageOf, nowOf, promptCostOf, setHealth, setHistory, setIsPlan, setLastUsage, updatePromptCost, updateSpend, writeConfig } from './state'
import { adviseSession } from './strategy'
import { messagesOf } from './tips'

type $ = EngineInterface

// Origins a person typed or drove: only these may change the routes, and only these are held by the cold guard.
export const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

/** What a status refresh measured, for the features that act on it once the band is up to date. */
export type HealthTick = { cfg: RouterConfig; warmMinutes: number; tokens: number; model: string }

export async function setConfig($: $, fn: (c: RouterConfig) => RouterConfig): Promise<RouterConfig> {
  const next = await writeConfig($, fn)
  await refreshStatus($).catch(() => undefined)
  return next
}

export async function mainRoute($: $): Promise<'plan' | 'main'> {
  return (await isPlanOf($)) ? 'plan' : 'main'
}

/** A main-loop route's model and effort, falling back to what the session runs. */
function loopRoute(cfg: RouterConfig, route: string, fallback: { model: string; effort?: string }) {
  const r = resolve(cfg, route)
  return { model: r.model ?? fallback.model, effort: r.effort ?? fallback.effort }
}

export async function routedMainModel($: $, cfg: RouterConfig, fallback: string): Promise<string> {
  return loopRoute(cfg, await mainRoute($), { model: fallback }).model
}

/**
 * Plan mode on or off. The engine raises no event on the toggle itself, so on
 * entering, the cost of getting here is already being paid; the lesson warns of the way back.
 */
export async function setPlan($: $, isOn: boolean) {
  const was = await isPlanOf($)
  await setIsPlan($, isOn)
  const cfg = await configOf($)
  if (was || !isOn || !cfg.isLearning) return
  const running = session.lastMain ?? { model: await $.session.model() }
  const tokens = (await $.session.usage()).context.tokens ?? 0
  pushLesson(lessonFromPlanToggle(loopRoute(cfg, 'plan', running), loopRoute(cfg, 'main', running), tokens, cfg.cacheTtlMinutes))
}

export const promptTokens = (last: LastUsage) => last.input + last.cacheRead + last.cacheWrite

/** The price of the next main-loop send when the cache has gone cold over a big context. */
export async function coldSend($: $, cfg: RouterConfig): Promise<{ at: number; text: string } | undefined> {
  const last = await lastUsageOf($)
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
export async function awayFacts($: $, cfg: RouterConfig, tokens?: number): Promise<AwayFacts | undefined> {
  const last = await lastUsageOf($)
  if (last === null) return undefined
  tokens ??= (await $.session.usage()).context.tokens ?? promptTokens(last)
  const warmMinutes = warmMinutesLeft(last.at, await nowOf($), cfg.cacheTtlMinutes)
  return { tokens, model: await routedMainModel($, cfg, last.model), ttlMinutes: cfg.cacheTtlMinutes, warmMinutes }
}

export async function refreshStatus($: $): Promise<HealthTick | undefined> {
  const last = await lastUsageOf($)
  if (last === null) return undefined
  const { context, rateLimits } = await $.session.usage()
  const tokens = context.tokens ?? promptTokens(last)
  const prompt = promptTokens(last)
  const five = rateLimits.find(one => one.kind === 'five_hour')
  const seven = rateLimits.find(one => one.kind === 'seven_day')
  const now = await nowOf($)
  const cfg = await configOf($)
  const ttl = cfg.cacheTtlMinutes
  const warmMinutes = warmMinutesLeft(last.at, now, ttl)
  if (session.compactCheckedAt === undefined || now - session.compactCheckedAt > 10 * 60_000) {
    const { context: detailed } = await $.session.usage({ breakdown: 'summary' })
    const b = detailed.breakdown
    session.compactAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    session.messagesShare = b && b.totalTokens > 0 ? messagesOf(b) / b.totalTokens : undefined
    session.compactCheckedAt = now
  }
  const model = await routedMainModel($, cfg, last.model)
  const advice = adviseSession({ tokens, window: context.window, compactAt: session.compactAt, model, ttlMinutes: ttl, warmMinutes, messagesShare: session.messagesShare, boundary: session.boundary, ...signalFacts() })
  const next: Health = {
    cache: prompt > 0 ? Math.round((last.cacheRead / prompt) * 100) : 0,
    warmMinutes,
    ctx: context.percent ?? Math.round((tokens / context.window) * 100),
    ctxLevel: contextLevel(tokens, context.window, session.compactAt),
    last: (await promptCostOf($))?.usd ?? last.usd,
    ...(warmMinutes === 0 && tokens >= GUARD_MIN_TOKENS ? { coldUsd: rewritePrice(model, tokens, ttl).write } : {}),
    ...(five ? { fiveHour: Math.round(five.percentUsed) } : {}),
    ...(seven ? { sevenDay: Math.round(seven.percentUsed) } : {}),
    ...(advice.verdict === 'continue' || !cfg.showNext ? {} : { advice: { verdict: advice.verdict, reason: advice.reason, text: advice.text, command: advice.command } }),
  }
  const prev = await healthOf($)
  await setHealth($, next)
  const tick: HealthTick = { cfg, warmMinutes, tokens, model }
  if (!cfg.isLearning) return tick
  for (const draft of [lessonFromContext(prev?.ctxLevel, next.ctxLevel, tokens, model, ttl, session.compactAt !== undefined), ...(cfg.showNext && cfg.isContext ? [lessonFromAdvice(prev?.advice, advice)] : [])]) {
    pushLesson(draft)
  }
  // The one lesson that can't wait for a turn to end: by then the cache has gone cold. Queued, because a refresh that
  // only measures (a setting changed) may be the one that sees the cache cross the line, and would otherwise use it up.
  const expiring = lessonFromExpiry(prev?.warmMinutes, warmMinutes, ttl, tokens, model)
  if (expiring !== undefined) pushUrgent(expiring)
  return tick
}

/** What a fresh context forgets; open steps, uncommitted edits and a saved handoff outlive a compaction, as Claude Code's own todo list does. */
export function resetSignals(isClear: boolean) {
  if (isClear) {
    session.steps = NO_STEPS
    session.editsSinceCommit = 0
  }
  session.planPath = undefined
  session.corrections = 0
  session.explored = 0
  session.isExploreTaught = false
}

export function signalFacts() {
  return {
    openSteps: openSteps(session.steps),
    planPath: tildePath(session.planPath, session.home),
    corrections: session.corrections,
    hasHandoffSkill: session.hasHandoffSkill,
    handoffPath: tildePath(session.handoffPath, session.home),
  }
}

/** The first time reads and searches fill the main context this session, learn mode explains subagents. */
async function noteExploration($: $) {
  if (session.isExploreTaught || session.explored < EXPLORE_MIN || !(await configOf($)).isLearning) return
  const total = (await $.session.usage()).context.tokens ?? 0
  if (!isExplorationHeavy(session.explored, total)) return
  session.isExploreTaught = true
  pushLesson(lessonFromExploration(session.explored, total))
}

/** Counts a finished tool call toward the MCP server or plugin behind it, and notes work being wrapped up, planned, tracked, edited or explored. */
export async function noteToolCall($: $, e: Args<'tool.call'>, result: unknown): Promise<{ handoffWritten?: { path: string; repo: string; text?: string } }> {
  const input = e as unknown as Record<string, unknown>
  let handoffWritten: { path: string; repo: string; text?: string } | undefined
  // A subagent's edits and commits change the same working tree, so they count too.
  session.editsSinceCommit = editsAfter(session.editsSinceCommit, e.tool, input, session.home)
  if (e.agentId === undefined) {
    if (e.tool === 'Bash' && typeof input.command === 'string') session.boundary = boundaryOf(input.command) ?? session.boundary
    session.steps = stepsAfter(session.steps, e.tool, input, result)
    const written = e.tool === 'Write' && typeof input.file_path === 'string' ? input.file_path : undefined
    const handoffRepo = written === undefined ? undefined : repoOfHandoff(written, session.home)
    if (written !== undefined && handoffRepo !== undefined) handoffWritten = { path: written, repo: handoffRepo, ...(typeof input.content === 'string' ? { text: input.content } : {}) }
    const plan = planEventOf(e.tool, input, result)
    if (plan?.kind === 'saved') session.planPath = plan.path
    if (plan?.kind === 'work') session.planPath = undefined
    const explored = exploredTokens(e.tool, result)
    if (explored > 0) {
      session.explored += explored
      void noteExploration($).catch(() => undefined)
    }
  }
  const items = await itemsOfToolUse($, e.tool, input)
  if (items.length === 0) return { handoffWritten }
  const at = await nowOf($)
  for (const key of items) noteUse(key, at, 1)
  // Kept for a reload without holding up the tool's result.
  void carry($).catch(() => undefined)
  return { handoffWritten }
}

export function recordOf(meta: { label: string; text: string; at: number }, p: PromptCost): PromptRecord {
  return {
    at: meta.at,
    repo: session.repo,
    label: meta.label,
    text: meta.text,
    usd: p.usd,
    requests: p.requests,
    agents: subagentCount(p),
    models: modelsOf(p),
    rewrites: p.rewrites,
  }
}

export async function recordPrompt($: $) {
  const p = await promptCostOf($)
  const meta = session.kept.current
  if (meta === undefined) return
  session.kept = { ...session.kept, current: undefined }
  await carry($)
  if (p === null || p.usd <= 0) return
  const rec = recordOf(meta, p)
  await setHistory($, all => [...all, rec].slice(-HISTORY_LIMIT))
}

/** Saved history plus the prompt still running, every repo; the Cost pane's History tab narrows it to one. */
export async function allRecords($: $): Promise<{ records: PromptRecord[]; now: number }> {
  const [saved, live, now] = await Promise.all([historyOf($), promptCostOf($), nowOf($)])
  const current = session.kept.current
  return { records: live && current && live.usd > 0 ? [...saved, recordOf(current, live)] : saved, now }
}

export async function routeKeyOfAgent($: $, agentId: string): Promise<string | undefined> {
  const known = session.agents.get(agentId)
  if (known !== undefined) return known.route
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed !== undefined) {
    const route = listed.teammateId !== undefined ? 'teammate' : listed.type === FORK ? FORK : `sub:${printable(listed.type)}`
    session.agents.set(agentId, { route })
    return route
  }
  // A workflow's agents and the engine's own forks (compaction, memory) are in no list: left on their model.
  return undefined
}

export function noteSpawn(agentId: string, route: string, label: string) {
  session.agents.set(agentId, { route, label, promptAt: session.kept.current?.at })
}

export type StepOutcome = {
  cfg: RouterConfig
  model: string
  effort?: Effort
  isHeld: boolean
  isAfterCompact: boolean
  usage: (Parameters<typeof costOf>[0] & { model: string }) | null | undefined
}

/** Counts one finished request: per-route spend, the prompt's breakdown, and, for the main loop, the facts behind the band. Gives back the route the main loop was on before. */
export async function recordStep($: $, agentId: string | undefined, key: string, s: StepOutcome): Promise<{ prevMainRoute?: string }> {
  const stepAt = await nowOf($)
  const isMain = agentId === undefined
  const usage = s.usage
  if (usage) {
    const ttl = s.cfg.cacheTtlMinutes
    const label = isMain ? (key === 'plan' ? 'Main loop (plan mode)' : 'Main loop') : (session.agents.get(agentId)?.label ?? key)
    const cause = isMain
      ? rewriteCause({ isAfterCompact: s.isAfterCompact, prevAt: session.lastMain?.at, now: stepAt, ttlMinutes: ttl, from: session.lastMain, to: { model: s.model, effort: s.effort } })
      : undefined
    const rewrite = rewriteOf(usage, usage.model, cause, ttl)
    if (isMain && rewrite !== undefined && s.cfg.isLearning) {
      pushLesson(lessonFromRewrite(rewrite, {
        model: usage.model,
        ttlMinutes: ttl,
        idleMs: session.lastMain === undefined ? undefined : stepAt - session.lastMain.at,
        from: session.lastMain,
        to: { model: usage.model, effort: s.effort },
      }))
    }
    await updateSpend($, all => ({ ...all, [key]: addSpend(all[key] ?? EMPTY_SPEND, usage, usage.model, ttl) }))
    const promptAt = isMain ? undefined : session.agents.get(agentId)?.promptAt
    if (promptAt !== undefined && promptAt !== session.kept.current?.at) {
      // A background agent outlived the prompt that started it: its cost belongs to that prompt's saved record.
      await setHistory($, all => all.map(r => (r.at === promptAt && r.repo === session.repo ? addLateStep(r, { usage, effort: s.effort, ttlMinutes: ttl }) : r)))
    } else {
      await updatePromptCost($, p => addStep(p ?? EMPTY_PROMPT, { id: agentId ?? key, route: key, label, effort: s.effort, usage, ttlMinutes: ttl, rewrite }))
    }
    if (isMain) {
      await setLastUsage($, {
        model: usage.model,
        input: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        usd: costOf(usage, usage.model, ttl),
        at: stepAt,
      })
    }
  }
  if (!isMain) return {}
  const prevMainRoute = session.lastMain?.route
  session.lastMain = { route: key, model: s.model, effort: s.effort, at: stepAt }
  return { prevMainRoute }
}
