import type { Args, EngineInterface, On } from 'claude-code'

import type { ColdGuard, Health, RouterConfig } from '../../types'
import { offText } from '../core/config'
import { money, plural, printable } from '../core/format'
import { GUARD_MIN_TOKENS, warmMinutesLeft } from '../core/pricing'
import { DEV_PATIENCE, claudeAiReport, claudeAiTips, idleReport, idleTips, listingTokens, mcpKey, patienceText, skillReport, skillTips } from '../core/usage'
import type { ItemKey } from '../core/usage'
import { idleHere, listCommands } from '../core/items'
import { USER_ORIGINS, awayFacts, coldSend, noteWarmPing, routedMainModel, setConfig, signalFacts } from '../core/measure'
import type { HealthTick } from '../core/measure'
import { closePanes } from '../core/panes'
import { session } from '../core/session'
import { STORE, UNREADABLE, configOf, healthOf, lastUsageOf, load, nowOf, save, setWarmRun, warmRunOf } from '../core/state'
import { adviseSession } from '../core/strategy'
import { messagesOf, tokensByServer } from '../core/tips'
import type { TipAction } from '../core/tips'
import { awayOptions, awayText } from '../learn/lessons'
import type { BandPart } from '../ui/band'
import { contextBandPart } from './band-part'
import { PANES } from '../ui/kit'
import { contextMobileView, contextPaneView } from './context-pane'
import { WARM_PROMPT, parseWarmHours, shouldPing } from './warm'

type $ = EngineInterface

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  coldAckedAt: undefined as number | undefined,
  // Slash commands seen to start a model turn, and the command that ran last, until a turn shows whether it did.
  modelCommands: new Set<string>(),
  lastCommand: undefined as string | undefined,
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

export async function setShowNext($: $, isOn: boolean): Promise<void> {
  await setConfig($, c => ({ ...c, showNext: isOn }))
}

/** `/route away`: the ways to step away, priced for this session as it stands. */
async function awayReport($: $): Promise<string> {
  const facts = await awayFacts($, await configOf($))
  return facts === undefined ? 'Nothing is cached in this session yet.' : awayText(facts)
}

/** Names to show: what the mod worked out, over the /mcp names of servers /context lists. */
const withServerNames = (names: Record<ItemKey, string>, servers: readonly { serverName: string }[]) => ({
  ...Object.fromEntries(servers.map(one => [mcpKey(one.serverName), one.serverName])),
  ...names,
})

/** `/route unused`: every idle MCP server and plugin here, or why nothing is listed yet. */
async function unusedReport($: $): Promise<string> {
  const [breakdown, { idle, only, loaded, repo, patience: idlePatience }] = await Promise.all([
    $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined),
    idleHere($),
  ])
  const here = printable(session.repo)
  const patience = `${patienceText(idlePatience)}${idlePatience === DEV_PATIENCE ? ' (MODEL_ROUTER_IDLE_DEV)' : ''}`
  if (repo === undefined) return `No usage recorded for ${here} yet. model-router notes which MCP servers, plugins and your own skills each repo uses; idle ones show here after ${patience}.`
  const lines = [...idleReport(idle, withServerNames(loaded.names, breakdown?.mcpTools ?? []), loaded.keys), ...skillReport(idle, only, loaded.own, session.root), ...claudeAiReport(idle, loaded.syncedCount)]
  if (lines.length === 0) {
    return `Nothing idle in ${here}: every MCP server, plugin and skill of yours loaded here was used in the last 30 days, or has been loaded for under ${patience} (${plural(repo.sessions, 'session')} recorded).`
  }
  return [`Unused in ${here} (${plural(repo.sessions, 'session')} recorded):`, ...lines.map(line => `  ${line}`)].join('\n')
}

async function renderContextPane($: $, e: Args<'ui.render'>) {
  if (e.surface === 'mobile') return contextMobileView($.ui.resolve(e))
  const columns = (e.component === 'Pane' ? e.props.bodyColumns : undefined) || 80
  const [{ context }, hp, cfg, { idle, only, loaded }] = await Promise.all([$.session.usage({ breakdown: 'summary', columns }), healthOf($), configOf($), idleHere($)])
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
    boundary: session.boundary,
    ...signalFacts(),
  })
  // Only once there is enough cached to be worth planning a break around: the cold guard's threshold.
  const facts = (context.tokens ?? 0) >= GUARD_MIN_TOKENS ? await awayFacts($, cfg, context.tokens) : undefined
  const away = facts && awayOptions(facts)
  const tokens = listingTokens(b?.skills?.skillFrontmatter ?? [])
  const tips = [...idleTips(idle, withServerNames(loaded.names, servers), tokensByServer(servers), { root: session.root, tokens }), ...skillTips(idle, only, loaded.own, session.root, tokens), ...claudeAiTips(idle, loaded.syncedCount, tokens)]
  const data = { breakdown: b, isTerminal: e.surface === 'terminal', columns, advice: advice || undefined, explored: session.explored, unused: tips, away }
  const fill = (text: string) => void $.prompt.fill({ text, mode: 'replace' }).catch(() => undefined)
  // A menu such as /mcp opens as if typed; where the engine refuses, it is left in the prompt instead.
  const act = (action: TipAction) => (action.isSlash ? void $.command.run({ command: action.command }).catch(() => fill(`/${action.command}`)) : fill(action.command))
  return contextPaneView($.ui.resolve(e), data, { act })
}

const GUARD_TEXT: Record<ColdGuard, string> = {
  refuse: 'Cold sends are dropped once with their price; the resend goes through.',
  warn: 'Cold sends go through with their price shown.',
  off: 'Cold-send guard off.',
}

export function registerContext(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANES.context.id }, async ($, e, next) => ((await configOf($)).isContext ? renderContextPane($, e) : next(e)))
}

export async function closeContextPane($: $): Promise<void> {
  await closePanes($, [PANES.context.id])
}

export function contextBand(cfg: RouterConfig, health: Health | null): BandPart | undefined {
  return cfg.isContext ? contextBandPart(health) : undefined
}

export function contextOnSessionStart(learned: unknown): void {
  if (Array.isArray(learned)) for (const one of learned) if (typeof one === 'string') mem.modelCommands.add(one)
}

/** The cold guard's line: the price, what happens next, and with learn mode on, why. */
const guardText = (cold: { text: string }, tail: string, why: string) => `model-router: ${cold.text} ${tail}${why}`

/** A person's message onto a cold prompt cache: logged under `warn`, dropped once under `refuse`, so the resend goes through. */
export async function holdColdPrompt($: $, cfg: RouterConfig, e: Args<'prompt.submit'>, why: string): Promise<{ drop: string } | undefined> {
  const guard = cfg.coldGuard
  // Only a person can resend a dropped message; a notification, trigger or peer message would be lost.
  if (!cfg.isContext || guard === 'off' || !USER_ORIGINS.has(e.origin.kind) || e.text.trimStart().startsWith('/')) return undefined
  const cold = await coldSend($, cfg).catch(() => undefined)
  if (cold !== undefined && guard === 'warn') $.ui.log(guardText(cold, 'Sending anyway.', why))
  if (cold !== undefined && guard === 'refuse' && mem.coldAckedAt !== cold.at) {
    mem.coldAckedAt = cold.at
    return { drop: guardText(cold, 'Send it again to pay it, or /clear and start from a note.', why) }
  }
  return undefined
}

/** The same for a slash command that starts a model turn. */
export async function holdColdCommand($: $, cfg: RouterConfig, e: Args<'command.run'>, why: string): Promise<{ text: string } | undefined> {
  if (!cfg.isContext || cfg.coldGuard === 'off' || !USER_ORIGINS.has(e.origin.kind)) return undefined
  const cold = await coldSend($, cfg).catch(() => undefined)
  if (cold === undefined || !(await reachesModel($, e.command))) return undefined
  if (cfg.coldGuard === 'warn') $.ui.log(guardText(cold, `Running /${e.command} anyway.`, why))
  else if (mem.coldAckedAt !== cold.at) {
    mem.coldAckedAt = cold.at
    return { text: guardText(cold, `Run /${e.command} again to pay it, or /clear and start from a note.`, why) }
  }
  return undefined
}

/** The command that ran last, until a turn shows whether it reached the model; a plain prompt clears it. */
export function contextNoteCommand(name: string | undefined): void {
  mem.lastCommand = name
}

export async function contextOnTurnStart($: $): Promise<void> {
  if (mem.lastCommand === undefined) return
  const name = mem.lastCommand
  mem.lastCommand = undefined
  await learnModelCommand($, name).catch(() => undefined)
}

export async function contextVerb($: $, verb: string, rest: string[], isPerson: boolean): Promise<{ text: string } | undefined> {
  if ((verb === 'away' || verb === 'unused') && !(await configOf($)).isContext) return { text: offText('context') }
  if (verb === 'away') return { text: await awayReport($) }
  if (verb === 'unused') return { text: await unusedReport($) }
  if (!isPerson) return undefined
  if (verb === 'warm') return { text: await warmVerb($, rest) }
  if (verb === 'next') {
    if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route next on|off (show next /clear, /compact or /handoff when carrying on is not the best move)' }
    const isOn = rest[0] === 'on'
    await setShowNext($, isOn)
    return { text: isOn ? 'Next-step advice on: the band shows next /clear, /compact or /handoff when carrying on is not the best move, with the reason in the Context pane.' : 'Next-step advice off: the band and the Context pane no longer suggest when to clear, compact or hand off.' }
  }
  if (verb === 'guard') {
    const mode = rest[0] as ColdGuard
    if (!Object.hasOwn(GUARD_TEXT, mode ?? '')) return { text: 'Usage: /route guard refuse|warn|off (what a send onto a cold prompt cache does)' }
    await setConfig($, c => ({ ...c, coldGuard: mode }))
    return { text: GUARD_TEXT[mode] }
  }
  return undefined
}

const WARM_USAGE = 'Usage: /route warm [1-6h] (keep the cache warm while you are away) or /route warm stop'

async function warmVerb($: $, rest: string[]): Promise<string> {
  if (rest[0] === 'stop' && rest.length === 1) {
    const run = await warmRunOf($)
    if (run === null) return "Keep warm isn't running."
    await stopWarm($, 'stop')
    return `Keep warm stopped (${plural(run.pings, 'ping')}, ${money(run.usd)}).`
  }
  if (rest.length > 1) return WARM_USAGE
  const hours = parseWarmHours(rest[0], (await configOf($)).warmHours)
  return hours === 'invalid' ? WARM_USAGE : startWarm($, hours)
}

/** Starts a run, or says why it can't help: Context off, the 5-minute cache, or a cache already cold. */
export async function startWarm($: $, hours: number): Promise<string> {
  const [cfg, last, now] = await Promise.all([configOf($), lastUsageOf($), nowOf($)])
  if (!cfg.isContext) return offText('context')
  if (cfg.cacheTtlMinutes !== 60) return 'Keep warm needs the 60-minute cache: /route ttl 60.'
  if (last === null || warmMinutesLeft(last.at, now, cfg.cacheTtlMinutes) === 0) return "Keep warm can't help: the cache is already cold."
  await setWarmRun($, () => ({ startedAt: now, until: now + hours * 3_600_000, usd: 0, pings: 0 }))
  return `Keeping the cache warm for up to ${hours} h; it stops when you send anything.`
}

const STOP_WHY = { ceiling: 'it reached its limit', cold: 'the cache went cold anyway' } as const

export async function stopWarm($: $, why: 'back' | 'stop' | 'off' | keyof typeof STOP_WHY): Promise<void> {
  const run = await warmRunOf($)
  if (run === null) return
  await setWarmRun($, () => null)
  if (why === 'ceiling' || why === 'cold') $.ui.log(`model-router: keep-warm stopped: ${STOP_WHY[why]}; ${plural(run.pings, 'ping')} cost ${money(run.usd)}.`)
}

/** On each status tick: ends a run at its limit or on a cold cache, and pings when the cache is in its last minutes. */
export async function contextOnTick($: $, tick: HealthTick): Promise<void> {
  const run = tick.warmRun
  if (run === null || session.isPinging) return
  const now = await nowOf($)
  if (now >= run.until) return stopWarm($, 'ceiling')
  if (tick.warmMinutes === 0) return stopWarm($, 'cold')
  if (!shouldPing(run, tick.warmMinutes, now)) return
  session.isPinging = true
  try {
    const reply = await $.model.fork({ prompt: WARM_PROMPT })
    // A fork that didn't answer (rate limit, overload, a turn in flight) is tried again on the next tick.
    if (reply.isAnswered && (await noteWarmPing($, reply.usage)) === 'cold') await stopWarm($, 'cold')
  } finally {
    session.isPinging = false
  }
}
