import type { Args, EngineInterface, Register } from 'claude-code'

import type { ColdGuard, RouterConfig } from '../types'
import { commandLabel, printable, typedText, versionOf } from './core/format'
import { EMPTY_PROMPT, sanitizeHistory, sumUsd, withoutText } from './core/ledger'
import { CACHE_TTLS, FEATURES, isFeatureOn, offText, startingConfig } from './core/config'
import { backfillUsage, flushUsage, listCommands, noteCommand, startItems } from './core/items'
import { USER_ORIGINS, noteSpawn, noteToolCall, promptTokens, recordPrompt, recordStep, refreshStatus, resetSignals } from './core/measure'
import type { StepOutcome } from './core/measure'
import { hasHandoffCommand, isCorrection } from './core/signals'
import { raisePane } from './core/panes'
import { session } from './core/session'
import { STORE, UNREADABLE, carriedOf, carry, configOf, healthOf, initBand, initConfig, initHistory, isBandShownOf, lastUsageOf, load, nowOf, save, setBand, setHistory, spendOf, updatePromptCost, writeConfig } from './core/state'
import { pushLesson, takeUrgent } from './learn/drafts'
import { closeOldLearnPane, guardWhy, learnBandCard, learnOnSessionStart, learnVerb, flushLessons, clearCard, setLearning, teach } from './learn/feature'
import { lessonFromCompact } from './learn/lessons'
import { ENGINE, asEffort, routeForSpawn } from './routing/routes'
import { registerRouting, renderRoutesPane, routingBandHead, routingDecide, routingNoteApplied, routingOnSpawn, routingOnTurnStart, routingVerb } from './routing/feature'
import { handoffsAfterPrompt, handoffsBandCount, handoffsOnFreshContext, handoffsOnOpen, handoffsOnSessionStart, handoffsOnTick, handoffsOnTurnComplete, handoffsOnTurnStart, handoffsOnUserPrompt, handoffsOnWrite, handoffsVerb, registerHandoffs, setAutoHandoff, setHandoffsOn } from './handoffs/feature'
import { bandView } from './ui/band'
import { closeContextPane, contextNoteCommand, contextOnSessionStart, contextOnTurnStart, contextVerb, contextBandPart, holdColdCommand, holdColdPrompt, registerContext, setShowNext } from './context/feature'
import { COST_TAB_LABEL, PANES, isTarget, paneOf } from './ui/kit'
import type { Open, Target } from './ui/kit'
import { closeCostPanes, costBandPart, costOnSessionStart, registerCost, registerCostFooter, setCostTab } from './cost/feature'

type $ = EngineInterface

/** Unlike core's `setConfig`, refreshes through `refresh`, so the auto-handoff check and the expiry lesson run too. */
async function setConfigAndRefresh($: $, fn: (c: RouterConfig) => RouterConfig): Promise<RouterConfig> {
  const next = await writeConfig($, fn)
  await refresh($).catch(() => undefined)
  return next
}

/** Turning it off also removes the text already kept, this prompt's included. */
async function setKeepText($: $, keep: boolean) {
  await setConfigAndRefresh($, c => ({ ...c, keepPromptText: keep }))
  if (keep) return
  if (session.kept.current) session.kept = { ...session.kept, current: { ...session.kept.current, text: '' } }
  await carry($)
  await setHistory($, withoutText)
}

/**
 * Says once which version runs after an update reaches this session. A fresh install only remembers it; an install
 * with settings from a version too old to record itself says it loaded, with no previous version to name.
 */
async function noteVersion($: $, hadSettings: boolean) {
  const [seen, manifest] = await Promise.all([load($, STORE.version), $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => undefined)])
  const now = typeof manifest === 'string' ? versionOf(manifest) : undefined
  if (seen === UNREADABLE || now === undefined || now === seen) return
  await save($, STORE.version, now)
  if (typeof seen === 'string') $.ui.toast(`model-router ${now} loaded (was ${seen})`)
  else if (hadSettings) $.ui.toast(`model-router ${now} loaded`)
}

/** Measures the session, then lets the features act on what it found. */
async function refresh($: $) {
  const tick = await refreshStatus($)
  if (tick === undefined) return
  void handoffsOnTick($, tick).catch(() => undefined)
  const urgent = takeUrgent()
  if (tick.cfg.isLearning && urgent.length > 0) await teach($, urgent, await nowOf($)).catch(() => undefined)
}

/** What opening a pane does besides showing it. */
async function onOpen($: $, pane: keyof typeof PANES) {
  if (pane === 'handoffs') await handoffsOnOpen($)
}

async function showPane($: $, target: Target) {
  const { pane, tab } = paneOf(target)
  if (tab !== undefined) await setCostTab($, tab)
  await Promise.all([onOpen($, pane).catch(() => undefined), raisePane($, pane).catch(() => undefined)])
}

const openPane = ($: $): Open => target => void showPane($, target)

async function renderBand($: $, e: Args<'ui.render'>) {
  const [head, costs, health, handoffsOpen] = await Promise.all([routingBandHead($), spendOf($), healthOf($), handoffsBandCount($)])
  const parts = {
    head,
    context: contextBandPart(head.cfg, health),
    cost: costBandPart(head.cfg, health, sumUsd(Object.values(costs))),
    handoffsOpen,
  }
  return bandView($.ui.resolve(e), parts, { open: openPane($) })
}

/** Counts a finished request, and for the main loop puts the route and the band's facts up to date. */
async function afterStep($: $, agentId: string | undefined, key: string, s: StepOutcome) {
  const { prevMainRoute } = await recordStep($, agentId, key, s)
  if (agentId !== undefined) return
  await routingNoteApplied($, { route: key, model: s.model, effort: s.effort, isHeld: s.isHeld, prevRoute: prevMainRoute, cfg: s.cfg })
  await refresh($)
}

const SWITCH_TEXT = {
  cost: {
    on: 'Cost on.',
    off: 'Cost off: no Cost pane, footer or band money; history keeps recording (/route stats clear deletes it).',
  },
  context: {
    on: 'Context on.',
    off: 'Context off: no Context pane, cold-send guard, next-step advice or band cache and context; measuring keeps running.',
  },
}

async function switchFeature($: $, feature: 'cost' | 'context', isOn: boolean) {
  await setConfigAndRefresh($, c => (feature === 'cost' ? { ...c, isCost: isOn } : { ...c, isContext: isOn }))
  if (!isOn) await (feature === 'cost' ? closeCostPanes($) : closeContextPane($))
}

/** `cost on|off` and `context on|off`, taken before `aliased` can read `cost on` as `on`, which is routing's switch. */
async function switchVerb($: $, words: readonly string[], isPerson: boolean): Promise<{ text: string } | undefined> {
  const [verb, state, ...more] = words
  if ((verb !== 'cost' && verb !== 'context') || (state !== 'on' && state !== 'off') || more.length > 0) return undefined
  if (!isPerson) return { text: `model-router: /route ${verb} only runs when you type it.` }
  await switchFeature($, verb, state === 'on')
  return { text: SWITCH_TEXT[verb][state] }
}

function featuresText(cfg: RouterConfig): string {
  const rows = FEATURES.map(one => `${one.key}  ${(isFeatureOn(cfg, one.key) ? 'on' : 'off').padEnd(3)}  ${one.line}`)
  return [...rows, 'Turn one on or off with /route <feature> on|off.'].join('\n')
}

/**
 * `/route` words in their current form: `cost <tab>` opens a tab as `<tab>` does,
 * `routing on|off` is `on|off`, and `handoff on|off` is the older name of `handoffs auto on|off`.
 */
function aliased(words: readonly string[]): string[] {
  const [verb, ...rest] = words
  if (verb === 'cost' && rest.length === 1) return rest
  if (verb === 'routing' && rest.length === 1 && (rest[0] === 'on' || rest[0] === 'off')) return rest
  if (verb === 'handoff') return ['handoffs', 'auto', ...rest]
  return [...words]
}

/** The verbs no feature owns. */
async function shellVerb($: $, verb: string, rest: string[]): Promise<{ text: string } | undefined> {
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
    await setConfigAndRefresh($, c => ({ ...c, cacheTtlMinutes: minutes }))
    return { text: `Cache lifetime set to ${minutes} minutes.` }
  }
  if (verb === 'band') {
    const isShown = rest[0] !== 'off'
    await setBand($, isShown)
    return { text: `Model router band ${isShown ? 'shown' : 'hidden'}.` }
  }
  return undefined
}

const USAGE = '[features | cost [last|session|history] | last | stats [clear | text on|off] | context | learn [on|off | mute|unmute <topic>] | handoffs [on|off | auto on|off] | next on|off | away | unused | preset <name> | set <route> <model> [effort] | on | off | band on|off | guard refuse|warn|off | ttl 5|60 | cost on|off | context on|off]'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [stored, saved, scope, band, learned, repo, storedLessons, storedHandoffs, handoffScopeSaved] = await Promise.all([
      load($, STORE.config),
      load($, STORE.history),
      load($, STORE.statsScope),
      load($, STORE.bandShown),
      load($, STORE.modelCommands),
      $.session.repo().catch(() => null),
      load($, STORE.lessons),
      load($, STORE.handoffs),
      load($, STORE.handoffScope),
    ])
    contextOnSessionStart(learned)
    const kept = saved === UNREADABLE ? [] : sanitizeHistory(saved)
    if (stored === UNREADABLE || saved === UNREADABLE) {
      $.ui.log('model-router: could not read saved settings or history; using defaults for this session and saving nothing over them.')
    } else {
      const cfg = startingConfig(stored, kept.length > 0)
      await initConfig($, cfg)
      // Saved on first run so the history check above decides once: a fresh install keeps `inherit` after it gains history.
      if (stored === undefined) await save($, STORE.config, cfg)
    }
    await initHistory($, kept)
    await learnOnSessionStart($, storedLessons)
    await costOnSessionStart($, scope)
    if (typeof band === 'boolean') await initBand($, band)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    session.repo = printable(repo?.name ?? (root.split('/').pop() || 'unknown'))
    session.root = root === '' ? undefined : root
    // The same session starting again, after a hot reload of this code or a /login, keeps its running prompt, count and unsaved calls.
    const [sessionId, before, idleDev, home, commands] = await Promise.all([
      $.session.id().catch(() => undefined),
      carriedOf($),
      $.env.get('MODEL_ROUTER_IDLE_DEV').catch(() => undefined),
      $.env.get('HOME').catch(() => undefined),
      listCommands($),
    ])
    session.home = home
    session.hasHandoffSkill = hasHandoffCommand(commands.map(one => one.name))
    const isSame = sessionId !== undefined && before?.sessionId === sessionId
    // A copy: noteUse writes into `used`, and the atom's own value is not ours to change in place.
    session.kept = isSame ? { ...before, used: { ...before.used } } : { sessionId, used: {}, isUncounted: true }
    if (!isSame) await carry($)
    await handoffsOnSessionStart($, storedHandoffs, handoffScopeSaved)
    startItems(idleDev)
    void backfillUsage($).catch(() => undefined)
    $.ui.status(undefined)
    await refresh($).catch(() => undefined)
    session.tick?.cancel()
    session.tick = $.clock.every(60_000, () => void refresh($).catch(() => undefined))
    void closeOldLearnPane($)
    void noteVersion($, stored !== undefined && stored !== UNREADABLE).catch(() => undefined)
    await $.command.register({ name: 'route', description: 'Model router: open the pane, or one of the verbs', argumentHint: USAGE })
    return next(e)
  })

  registerRouting(on)

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !ran.isError) {
      const noted = await noteToolCall($, e, ran.result).catch(() => undefined)
      if (noted?.handoffWritten !== undefined) await handoffsOnWrite($, noted.handoffWritten).catch(() => undefined)
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const before = (await configOf($)).isLearning ? await lastUsageOf($) : undefined
    const done = await next(e)
    if (e.agentId === undefined) {
      session.isAfterCompact = true
      session.boundary = undefined
      resetSignals(false)
      if (before !== undefined) pushLesson(lessonFromCompact(before === null ? 0 : promptTokens(before)))
    }
    return done
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(await routingOnSpawn($, e))
    if (started.agentId !== undefined) {
      noteSpawn(started.agentId, routeForSpawn(e), printable(`${e.subagentType} · ${e.description}`))
    }
    return started
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    let resumeText: string | undefined
    if (e.turnId === undefined) {
      const cfg = await configOf($)
      const held = await holdColdPrompt($, cfg, e, guardWhy(cfg))
      if (held !== undefined) return held
      if (USER_ORIGINS.has(e.origin.kind)) {
        resumeText = handoffsOnUserPrompt(e.text)
      }
      session.pendingPrompt = commandLabel(e.text)
      if (!e.text.trimStart().startsWith('/')) contextNoteCommand(undefined)
    }
    if (USER_ORIGINS.has(e.origin.kind) && !e.text.trimStart().startsWith('/')) session.corrections = isCorrection(e.text) ? session.corrections + 1 : 0
    if (USER_ORIGINS.has(e.origin.kind) && commandLabel(e.text) !== '/route') await clearCard($)
    const out = await next(e)
    // Marked once the prompt is through: a hook further down may still drop it.
    if (resumeText !== undefined && out.drop === undefined) {
      await handoffsAfterPrompt($, resumeText)
    }
    return out
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command === 'route') return next(e)
    await noteCommand($, e.command).catch(() => undefined)
    const cfg = await configOf($)
    const held = await holdColdCommand($, cfg, e, guardWhy(cfg))
    if (held !== undefined) return held
    session.pendingPrompt = `/${e.command}`
    contextNoteCommand(e.command)
    const done = await next(e)
    if (e.command === 'clear') {
      session.boundary = undefined
      await carry($)
      resetSignals(true)
      handoffsOnFreshContext()
      await clearCard($)
      await refresh($).catch(() => undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    // One short time limit covers every session.end hook, so both saves run at once.
    await Promise.all([recordPrompt($).catch(() => undefined), flushUsage($, false).catch(() => undefined)])
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    session.isTurnRunning = true
    await contextOnTurnStart($)
    const cfg = await configOf($)
    const handoffLabel = handoffsOnTurnStart(e.turnId, e.text)
    if (handoffLabel !== undefined) session.pendingPrompt = handoffLabel
    if (session.pendingPrompt !== undefined) {
      const label = session.pendingPrompt
      session.pendingPrompt = undefined
      session.boundary = undefined
      await recordPrompt($).catch(() => undefined)
      const [at, sessionId] = await Promise.all([nowOf($), $.session.id().catch(() => session.kept.sessionId)])
      // A /clear starts a new session without a session.start: count it, and let a reload recognise it.
      const isNew = sessionId !== session.kept.sessionId
      const current = { label, text: cfg.keepPromptText ? printable(typedText(e.text).slice(0, 120)) : '', at }
      session.kept = { ...session.kept, current, ...(isNew ? { sessionId, isUncounted: true } : {}) }
      // Plan approval's "clear context" and /resume change the session without a /clear.
      if (isNew) {
        resetSignals(true)
        handoffsOnFreshContext()
        await clearCard($)
      }
      await carry($)
      await updatePromptCost($, () => EMPTY_PROMPT)
    }
    await routingOnTurnStart($, e, cfg)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const cfg = await configOf($)
    const { route, model, effort, isHeld, isAfterCompact } = await routingDecide($, e, cfg)

    const isChanged = model !== e.model || effort !== asEffort(e.effort)
    const result = yield* next(isChanged ? { ...e, model, ...(effort ? { effort } : {}) } : e)

    // Bookkeeping never fails the request it is counting.
    await afterStep($, e.agentId, route ?? ENGINE, { cfg, model, effort, isHeld, isAfterCompact, usage: result.usage }).catch(() => undefined)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      session.isTurnRunning = false
      if (await handoffsOnTurnComplete($, e).catch(() => false)) await refresh($).catch(() => undefined)
      await flushLessons($).catch(() => undefined)
      await flushUsage($, true).catch(() => undefined)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'route' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const isPerson = USER_ORIGINS.has(e.origin.kind)
    const switched = await switchVerb($, words, isPerson)
    if (switched !== undefined) return switched
    const [verb = 'route', ...rest] = aliased(words)
    if (rest.length === 0 && isTarget(verb)) {
      const { pane, tab } = paneOf(verb)
      if ((pane === 'cost' || pane === 'context') && !isFeatureOn(await configOf($), pane)) return { text: offText(pane) }
      await showPane($, verb)
      return { text: tab === undefined ? `${PANES[pane].title} pane opened.` : `Cost pane opened on ${COST_TAB_LABEL[tab]}.` }
    }
    if (verb === 'features' && rest.length === 0) return { text: featuresText(await configOf($)) }
    const answered =
      (await routingVerb($, verb, rest, isPerson)) ??
      (await contextVerb($, verb, rest, isPerson)) ??
      (await handoffsVerb($, verb, rest, isPerson)) ??
      (await learnVerb($, verb, rest, isPerson))
    if (answered !== undefined) return answered
    if (!isPerson) return { text: `model-router: /route ${verb} only runs when you type it.` }
    return (await shellVerb($, verb, rest)) ?? { text: `Usage: /route ${USAGE}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANES.route.id }, ($, e) =>
    renderRoutesPane($, e, {
      setLearning: isOn => void setLearning($, isOn),
      setHandoffs: isOn => void setHandoffsOn($, isOn),
      setAutoHandoff: isOn => void setAutoHandoff($, isOn),
      setShowNext: isOn => void setShowNext($, isOn),
      setCost: isOn => void switchFeature($, 'cost', isOn),
      setContext: isOn => void switchFeature($, 'context', isOn),
      setGuard: (mode: ColdGuard) => void setConfigAndRefresh($, c => ({ ...c, coldGuard: mode })),
      setTtl: minutes => void setConfigAndRefresh($, c => ({ ...c, cacheTtlMinutes: minutes })),
      setKeepText: keep => void setKeepText($, keep),
      openHandoffs: () => openPane($)('handoffs'),
    }),
  )

  registerContext(on)

  registerCost(on)

  registerHandoffs(on)

  registerCostFooter(on)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [card, isShown] = await Promise.all([learnBandCard($, e), isBandShownOf($)])
    if (card === null && !isShown) return next(e)
    const band = isShown ? await renderBand($, e) : null
    const others = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {card}
        {band}
        {others}
      </Box>
    )
  })
}
