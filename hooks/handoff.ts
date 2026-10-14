import { GUARD_MIN_TOKENS } from './routes'
import { OPEN_MIN } from './signals'

export const HANDOFF_LABEL = 'auto-handoff'
export const HANDOFF_DIR = '.claude/handoffs'

export const HANDOFF_PROMPT =
  'The prompt cache expires in a few minutes and work is still open. Reply with a handoff document in Markdown and nothing else: the goal, what is done, files touched, decisions and their reasons, and the exact next step, then last the open steps in order under an "## Open steps" heading, as a numbered list, each step starting with (you) or (claude) for who does it. Do not call any tools.'

export type HandoffFacts = {
  isOn: boolean
  /** No auto-handoff since the person last prompted. */
  isArmed: boolean
  /** No turn and no subagent running. */
  isIdle: boolean
  isPromptEmpty: boolean
  /** Somewhere to save it: without a home directory the turn would be spent for nothing. */
  canSave: boolean
  warmMinutes: number
  ttlMinutes: number
  tokens: number
  openSteps: number
  hasPlan: boolean
}

// The status tick runs once a minute, so a 5-minute cache needs a window it cannot step over.
export const handoffWindow = (ttlMinutes: number) => (ttlMinutes >= 60 ? 3 : 2)

/** Whether to ask for a handoff now: the cache's last minutes, work open, and nobody typing or running. */
export function shouldAutoHandoff(f: HandoffFacts): boolean {
  return (
    f.isOn &&
    f.isArmed &&
    f.isIdle &&
    f.isPromptEmpty &&
    f.canSave &&
    f.warmMinutes > 0 &&
    f.warmMinutes <= handoffWindow(f.ttlMinutes) &&
    f.tokens >= GUARD_MIN_TOKENS &&
    (f.openSteps >= OPEN_MIN || f.hasPlan)
  )
}

/** `waiting` is held on its own background work or a plan's approval, so still busy; `idle` may wait for a message forever and must not block the handoff. */
export const isAgentBusy = (status: string) => status === 'pending' || status === 'running' || status === 'waiting'

export type PendingHandoff ={ turnId?: string; tokens: number; model: string } | undefined
type PendingEvent = { kind: 'submitted'; isDropped: boolean } | { kind: 'user-prompt' } | { kind: 'fresh-context' }

/** A handoff asked for and not yet started is dropped once a refused submit, a prompt of yours or a fresh context outlives it; one already running is kept for its reply. */
export function pendingAfter(pending: PendingHandoff, event: PendingEvent): PendingHandoff {
  if (pending === undefined) return undefined
  if (event.kind === 'submitted') return event.isDropped ? undefined : pending
  if (event.kind === 'user-prompt') return pending.turnId === undefined ? undefined : pending
  return undefined
}

const pad = (n: number) => String(n).padStart(2, '0')
export const segment = (text: string) => text.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '-') || '-'

export const handoffsRoot = (home: string) => `${home.replace(/\/+$/, '')}/${HANDOFF_DIR}`
export const handoffDir = (home: string, repo: string) => `${handoffsRoot(home)}/${segment(repo)}`

/** `<home>/.claude/handoffs/<repo>/<YYYY-MM-DD-HHMM>-<session id, 8 chars>.md`, in local time. */
export function handoffPath(home: string, repo: string, now: number, sessionId: string): string {
  const d = new Date(now)
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  return `${handoffDir(home, repo)}/${stamp}-${segment(sessionId).slice(0, 8)}.md`
}

export function tildePath(path: string, home: string | undefined): string
export function tildePath(path: string | undefined, home: string | undefined): string | undefined
export function tildePath(path: string | undefined, home: string | undefined): string | undefined {
  return path !== undefined && home !== undefined && home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
