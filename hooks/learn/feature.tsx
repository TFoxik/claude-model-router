import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface } from 'claude-code'

import type { LearnCard, Lesson, LessonKind, RouterConfig } from '../../types'
import { isLessonKind } from '../core/config'
import { setConfig } from '../core/measure'
import { session } from '../core/session'
import { STORE, UNREADABLE, configOf, load, nowOf, promptCostOf, save } from '../core/state'
import { OLD_LEARN_ID } from '../ui/kit'
import { dropLessons, takeLessons } from './drafts'
import { learnCardView } from './learn-card'
import { CONCEPTS, TOPICS, capLessons, cardOf, lessonsFromPrompt, pickLesson, sanitizeLessons } from './lessons'
import type { LessonDraft } from './lessons'

type $ = EngineInterface

// The engine's scan accepts an atom only in the file that declares it, so other files go through the functions below.
const lessons = atom({ plugin: 'model-router', key: 'lessons' } as const, [] as Lesson[])
const learnCard = atom({ plugin: 'model-router', key: 'learnCard' } as const, null as LearnCard | null)

const LEARN_ON_TEXT =
  'Learn mode on: when a cache rewrite, a pricey model, a growing context or busy subagents cost you, a card above the band explains it with the numbers, until your next prompt.'

const muteText = (kind: LessonKind) => `Learn mode stays quiet about "${CONCEPTS[kind].title}" now. /route learn unmute ${kind} brings it back.`

export async function learnOnSessionStart($: $, stored: unknown): Promise<void> {
  if (stored !== UNREADABLE) await update($, lessons, () => sanitizeLessons(stored))
}

async function setLessons($: $, fn: (all: Lesson[]) => Lesson[]): Promise<Lesson[]> {
  const stored = await load($, STORE.lessons)
  const next = await update($, lessons, all => fn(stored === UNREADABLE || stored === undefined ? all : sanitizeLessons(stored)))
  if (stored !== UNREADABLE) await save($, STORE.lessons, next)
  return next
}

/** Keeps what the finished main-loop turn taught, and puts the one most worth it on the card. */
export async function flushLessons($: $): Promise<void> {
  const drafts = takeLessons()
  const [cfg, p] = await Promise.all([configOf($), promptCostOf($)])
  if (!cfg.isLearning) return
  await teach($, [...drafts, ...(p === null ? [] : lessonsFromPrompt(p, cfg.cacheTtlMinutes))], await nowOf($))
}

/** Keeps the lessons of topics not muted and puts the one most worth it on the card, if any is due. */
export async function teach($: $, drafts: readonly LessonDraft[], now: number): Promise<void> {
  const { learnMuted } = await configOf($)
  const all = drafts.filter(d => !learnMuted.includes(d.kind))
  if (all.length === 0) return
  let card: LearnCard | undefined
  await setLessons($, earlier => {
    const { sessionId } = session.kept
    const fresh: Lesson[] = all.map(d => ({ ...d, at: now, repo: session.repo, ...(sessionId === undefined ? {} : { sessionId }) }))
    const pick = pickLesson(fresh, earlier, now)
    card = pick && cardOf(pick, earlier, fresh.length)
    return capLessons([...earlier, ...fresh.map(one => (one === pick ? { ...one, isToasted: true } : one))])
  })
  const shown = card
  if (shown === undefined) return
  const [, isDrawn] = await Promise.all([update($, learnCard, () => shown), isCardDrawn($)])
  if (!isDrawn) $.ui.toast(`${CONCEPTS[shown.kind].title}: ${shown.fact}`)
}

export async function clearCard($: $): Promise<void> {
  await update($, learnCard, () => null)
}

/** Only the terminal and the desktop draw above the prompt; a session drawn elsewhere alone gets the lesson as a toast. */
async function isCardDrawn($: $) {
  const surfaces = await $.session.surfaces().catch(() => [])
  return surfaces.length === 0 || surfaces.some(one => one === 'terminal' || one === 'desktop')
}

/** Learn mode on or off; off drops what the running turn had drafted and the card, so nothing is kept or shown from it. */
export async function setLearning($: $, isOn: boolean): Promise<void> {
  if (!isOn) {
    dropLessons()
    await clearCard($)
  }
  await setConfig($, c => ({ ...c, isLearning: isOn }))
}

async function setMuted($: $, kind: LessonKind, isMuted: boolean): Promise<void> {
  await setConfig($, c => ({ ...c, learnMuted: isMuted ? [...new Set([...c.learnMuted, kind])] : c.learnMuted.filter(one => one !== kind) }))
  if (isMuted && (await read($, learnCard))?.kind === kind) await clearCard($)
}

async function muteFromCard($: $, kind: LessonKind) {
  await setMuted($, kind, true)
  $.ui.toast(muteText(kind))
}

export async function closeOldLearnPane($: $): Promise<void> {
  if ((await $.ui.panes().catch(() => [])).some(one => one.id === OLD_LEARN_ID)) await $.ui.close({ id: OLD_LEARN_ID }).catch(() => undefined)
}

/** The card above the band, or `null` when there is none. */
export async function learnBandCard($: $, e: Args<'ui.render'>) {
  const card = await read($, learnCard)
  if (card === null) return null
  const actions = { dismiss: () => void clearCard($), mute: () => void muteFromCard($, card.kind) }
  return learnCardView($.ui.resolve(e), card, actions)
}

async function learnStatus($: $): Promise<string> {
  const cfg = await configOf($)
  const muted = cfg.learnMuted.length === 0 ? ['No topics muted.'] : cfg.learnMuted.map(kind => `Muted: ${kind} (/route learn unmute ${kind})`)
  return [`Learn mode is ${cfg.isLearning ? 'on' : 'off'}.`, ...muted].join('\n')
}

/** What the cold guard's line adds with learn mode on: why a cache rewrite costs what it does. */
export function guardWhy(cfg: RouterConfig): string {
  return cfg.isLearning && !cfg.learnMuted.includes('cold-rewrite') ? `\n\nWhy: ${CONCEPTS['cold-rewrite'].body}` : ''
}

export async function learnVerb($: $, verb: string, rest: string[], isPerson: boolean): Promise<{ text: string } | undefined> {
  if (verb !== 'learn') return undefined
  if (rest.length === 0) return { text: await learnStatus($) }
  if (!isPerson) return undefined
  if (rest[0] === 'on' || rest[0] === 'off') {
    const isOn = rest[0] === 'on'
    await setLearning($, isOn)
    return { text: isOn ? LEARN_ON_TEXT : 'Learn mode off.' }
  }
  if (rest[0] === 'mute' || rest[0] === 'unmute') {
    const kind = rest[1]
    if (!isLessonKind(kind)) return { text: `Usage: /route learn mute|unmute <topic>, topics: ${TOPICS.join(', ')}` }
    const isMuted = rest[0] === 'mute'
    await setMuted($, kind, isMuted)
    const title = CONCEPTS[kind].title
    return { text: isMuted ? muteText(kind) : `Learn mode explains "${title}" again.` }
  }
  return undefined
}
