import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On } from 'claude-code'

import type { Scope } from '../../types'
import type { HealthTick } from '../core/measure'
import { setConfig } from '../core/measure'
import { session } from '../core/session'
import { STORE, UNREADABLE, configOf, load, nowOf, promptCostOf, save } from '../core/state'
import { openSteps } from '../core/signals'
import { rewritePrice } from '../core/pricing'
import { pushLesson } from '../learn/drafts'
import { lessonFromAutoHandoff } from '../learn/lessons'
import { PANES } from '../ui/kit'
import { HANDOFF_DIR, HANDOFF_LABEL, HANDOFF_PROMPT, handoffPath, handoffPrompt, isAgentBusy, pendingAfter, segment, shouldAutoHandoff, tildePath } from './handoff'
import type { PendingHandoff } from './handoff'
import { handoffsPaneView } from './handoffs-pane'
import { bandCount, closeMarked, detailsOf, handoffDir, handoffRows, handoffsRoot, mergeListing, recordWritten, reopen, resumeIn, sanitizeHandoffs, setStatus, withDetails } from './records'
import type { HandoffStatus, Handoffs } from './records'

type $ = EngineInterface

// The engine's scan accepts an atom only in the file that declares it, so other files go through the functions below.
const handoffs = atom({ plugin: 'model-router', key: 'handoffs' } as const, {} as Handoffs)
const handoffScope = atom({ plugin: 'model-router', key: 'handoffScope' } as const, 'repo' as Scope)
const handoffClosedShown = atom({ plugin: 'model-router', key: 'handoffClosedShown' } as const, false)

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  // Whether an auto-handoff may still run before the person prompts again.
  handoffArmed: false,
  // The auto-handoff asked for and not yet answered: its turn once it starts, and the context it would have rewritten cold.
  handoff: undefined as PendingHandoff,
  handoffsChain: Promise.resolve() as Promise<unknown>,
}

const HANDOFFS_ON_TEXT = 'Handoffs on: the band counts handoffs other sessions left open, and auto-handoff runs when it is on (/route handoffs auto on|off).'
const HANDOFFS_OFF_TEXT = 'Handoffs off: no count in the band and no auto-handoff. Handoffs you save with /handoff are still listed in /route handoffs.'

const handoffOnText = (repo: string) =>
  `Auto-handoff on: when the cache is about to go cold with steps open or a plan not yet started, model-router asks Claude for a handoff while the cache is still warm and saves it under ~/${HANDOFF_DIR}/${segment(repo)}/. It runs once per prompt and never clears the session itself.`

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
  const [at, sessionId] = [await nowOf($), session.kept.sessionId]
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
  const home = session.home
  if (home === undefined) return
  const inScope = scope ?? (await read($, handoffScope))
  const repos = inScope === 'repo' ? [segment(session.repo)] : ((await $.fs.list(handoffsRoot(home)).catch(() => undefined))?.filter(one => one.kind === 'dir').map(one => one.name) ?? [])
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
  const [all, scope, isClosedShown, now, cfg] = await Promise.all([read($, handoffs), read($, handoffScope), read($, handoffClosedShown), nowOf($), configOf($)])
  const repo = segment(session.repo)
  const { open, closed } = handoffRows(all, scope === 'repo' ? repo : undefined, now)
  const folder = session.home === undefined ? `~/${HANDOFF_DIR}/` : tildePath(scope === 'repo' ? handoffDir(session.home, repo) : handoffsRoot(session.home), session.home)
  return handoffsPaneView($.ui.resolve(e), { open, closed, isClosedShown, scope, repo, folder, isOn: cfg.isHandoffs }, {
    setOn: isOn => void setHandoffsOn($, isOn),
    resume: path => void $.prompt.fill({ text: `resume from ${tildePath(path, session.home)}`, mode: 'replace' }).catch(() => undefined),
    setStatus: (path, status: HandoffStatus) => void setHandoffs($, records => setStatus(records, path, status)),
    reopen: path => void nowOf($).then(at => setHandoffs($, records => reopen(records, path, at))),
    toggleClosed: () => void update($, handoffClosedShown, was => !was),
    setScope: async next => {
      await save($, STORE.handoffScope, await update($, handoffScope, () => next))
      await refreshHandoffs($)
    },
  })
}

export function registerHandoffs(on: On): void {
  on('ui.render', { component: 'Pane', requestId: PANES.handoffs.id }, ($, e) => renderHandoffsPane($, e))
}

/** The band only needs this repo's; the pane lists every repo when it opens under All. */
export async function handoffsOnSessionStart($: $, stored: unknown, scope: unknown): Promise<void> {
  if (stored !== UNREADABLE) await update($, handoffs, () => sanitizeHandoffs(stored))
  if (scope === 'repo' || scope === 'all') await update($, handoffScope, () => scope)
  void refreshHandoffs($, 'repo').catch(() => undefined)
}

/** What opening the Handoffs pane does besides showing it. */
export async function handoffsOnOpen($: $): Promise<void> {
  await refreshHandoffs($)
}

export async function handoffsOnWrite($: $, w: { path: string; repo: string; text?: string }): Promise<void> {
  await recordHandoff($, w.path, w.repo, w.text)
}

/** In the cache's last minutes with work open, asks Claude for a handoff while reading the context is still cheap. */
export async function handoffsOnTick($: $, tick: HealthTick): Promise<void> {
  const { cfg } = tick
  const facts = {
    isOn: cfg.isHandoffs && cfg.autoHandoff,
    isArmed: mem.handoffArmed && mem.handoff === undefined,
    isIdle: !session.isTurnRunning,
    isPromptEmpty: true,
    canSave: session.home !== undefined,
    warmMinutes: tick.warmMinutes,
    ttlMinutes: cfg.cacheTtlMinutes,
    tokens: tick.tokens,
    openSteps: openSteps(session.steps),
    hasPlan: session.planPath !== undefined,
    editsSinceCommit: session.editsSinceCommit,
  }
  if (!shouldAutoHandoff(facts)) return
  // Claimed before the awaits, so a refresh running alongside cannot submit a second one.
  mem.handoffArmed = false
  const [agents, box] = await Promise.all([$.agent.list().catch(() => []), $.prompt.read()])
  const isIdle = !session.isTurnRunning && !agents.some(one => isAgentBusy(one.status))
  if (!shouldAutoHandoff({ ...facts, isIdle, isPromptEmpty: box.text.trim() === '' })) {
    mem.handoffArmed = true
    return
  }
  mem.handoff = { tokens: tick.tokens, model: tick.model }
  const sent = await $.prompt.submit({ text: handoffPrompt(facts.editsSinceCommit) }).catch(() => undefined)
  mem.handoff = pendingAfter(mem.handoff, { kind: 'submitted', isDropped: sent === undefined || sent.drop !== undefined })
}

/** A person's prompt re-arms the auto-handoff and drops the handoff path. */
export function handoffsOnUserPrompt(): void {
  mem.handoff = pendingAfter(mem.handoff, { kind: 'user-prompt' })
  mem.handoffArmed = true
  session.handoffPath = undefined
}

/** Marked once the prompt is through: a hook further down may still drop it. */
export async function handoffsAfterPrompt($: $, resumeText: string): Promise<void> {
  await setHandoffs($, all => resumeIn(all, resumeText, session.home)).catch(() => undefined)
}

/** The auto-handoff's own submit never reaches this plugin's prompt.submit hook, so its turn is told by its text. */
export function handoffsOnTurnStart(turnId: string, text: string): string | undefined {
  if (mem.handoff === undefined || mem.handoff.turnId !== undefined || !text.includes(HANDOFF_PROMPT)) return undefined
  mem.handoff = { ...mem.handoff, turnId }
  return HANDOFF_LABEL
}

/** Writes the auto-handoff turn's reply to its file; an interrupted, failed or empty turn saves nothing. True when the file was written. */
export async function handoffsOnTurnComplete($: $, e: Args<'turn.complete'>): Promise<boolean> {
  const asked = mem.handoff
  if (asked?.turnId === undefined || asked.turnId !== e.turnId) return false
  mem.handoff = undefined
  if (e.reason !== 'answer' || e.answer.trim() === '' || session.home === undefined) return false
  const [now, sessionId, cost, cfg] = await Promise.all([nowOf($), $.session.id().catch(() => session.kept.sessionId), promptCostOf($), configOf($)])
  const path = handoffPath(session.home, session.repo, now, sessionId ?? 'session')
  try {
    await $.fs.write(path, `${e.answer.trim()}\n`)
  } catch (err) {
    $.ui.log(`model-router: could not save the auto-handoff to ${path}: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
  session.handoffPath = path
  await recordHandoff($, path, segment(session.repo), e.answer)
  if (cfg.isLearning) {
    const avoidedUsd = rewritePrice(asked.model, asked.tokens, cfg.cacheTtlMinutes).write
    pushLesson(lessonFromAutoHandoff({ spentUsd: cost?.usd ?? 0, avoidedUsd, tokens: asked.tokens, path: tildePath(path, session.home) }))
  }
  return true
}

/** A fresh context leaves no handoff to resume from, and an auto-handoff asked for before it is no longer wanted. */
export function handoffsOnFreshContext(): void {
  session.handoffPath = undefined
  mem.handoff = pendingAfter(mem.handoff, { kind: 'fresh-context' })
}

export async function handoffsBandCount($: $): Promise<number> {
  const [records, cfg, now] = await Promise.all([read($, handoffs), configOf($), nowOf($)])
  return !cfg.isHandoffs ? 0 : bandCount(records, segment(session.repo), session.kept.sessionId, now)
}

export async function setHandoffsOn($: $, isOn: boolean): Promise<void> {
  await setConfig($, c => ({ ...c, isHandoffs: isOn }))
}

export async function setAutoHandoff($: $, isOn: boolean): Promise<void> {
  await setConfig($, c => ({ ...c, autoHandoff: isOn }))
}

export async function handoffsVerb($: $, verb: string, rest: string[], isPerson: boolean): Promise<{ text: string } | undefined> {
  if (verb !== 'handoffs' || !isPerson) return undefined
  if (rest[0] === 'auto') {
    const autoSwitch = rest[1]
    if (autoSwitch !== 'on' && autoSwitch !== 'off') return { text: 'Usage: /route handoffs auto on|off (save a handoff while the cache is still warm, before it goes cold with work open)' }
    const isOn = autoSwitch === 'on'
    await setAutoHandoff($, isOn)
    return { text: isOn ? handoffOnText(session.repo) : 'Auto-handoff off.' }
  }
  if (rest[0] !== 'on' && rest[0] !== 'off') return { text: 'Usage: /route handoffs on|off (the Handoffs pane, the band\'s count and auto-handoff), /route handoffs auto on|off, or /route handoffs to open the pane' }
  const isOn = rest[0] === 'on'
  await setHandoffsOn($, isOn)
  return { text: isOn ? HANDOFFS_ON_TEXT : HANDOFFS_OFF_TEXT }
}
