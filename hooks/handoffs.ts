import type { HandoffRecord, HandoffStatus, Handoffs } from '../types'
import { HANDOFF_DIR, segment, tildePath } from './handoff'

export type { HandoffRecord, HandoffStatus, Handoffs }
export type HandoffRow = { path: string; repo: string; at: number; title: string; reason?: string }

export const STALE_MS = 14 * 86_400_000
const KEPT = 500
const STATUSES: ReadonlySet<string> = new Set(['open', 'done', 'dropped', 'resumed', 'superseded'])
const REASON: Record<Exclude<HandoffStatus, 'open'>, string> = { done: 'done', dropped: 'not relevant', resumed: 'resumed', superseded: 'superseded' }

export const handoffsRoot = (home: string) => `${home.replace(/\/+$/, '')}/${HANDOFF_DIR}`
export const handoffDir = (home: string, repo: string) => `${handoffsRoot(home)}/${segment(repo)}`

export function repoOfHandoff(path: string, home: string | undefined): string | undefined {
  if (home === undefined || home === '') return undefined
  const root = `${handoffsRoot(home)}/`
  if (!path.startsWith(root) || !path.endsWith('.md')) return undefined
  const parts = path.slice(root.length).split('/')
  return parts.length === 2 && parts[0] !== '' ? parts[0] : undefined
}

function isRecord(value: unknown): value is HandoffRecord {
  const r = value as Partial<HandoffRecord> | null
  return (
    typeof r === 'object' && r !== null &&
    typeof r.repo === 'string' &&
    typeof r.at === 'number' && Number.isFinite(r.at) &&
    typeof r.status === 'string' && STATUSES.has(r.status) &&
    (r.sessionId === undefined || typeof r.sessionId === 'string') &&
    (r.title === undefined || typeof r.title === 'string')
  )
}

const clean = ({ repo, at, sessionId, title, status }: HandoffRecord): HandoffRecord => ({
  repo,
  at,
  ...(sessionId === undefined ? {} : { sessionId }),
  ...(title === undefined ? {} : { title }),
  status,
})

const newest = (records: Handoffs): Handoffs =>
  Object.fromEntries(Object.entries(records).sort((a, b) => b[1].at - a[1].at).slice(0, KEPT))

export function sanitizeHandoffs(raw: unknown): Handoffs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const ok = Object.entries(raw as Record<string, unknown>).filter((one): one is [string, HandoffRecord] => isRecord(one[1]))
  return newest(Object.fromEntries(ok.map(([path, r]) => [path, clean(r)])))
}

/** The newest handoff of a session carries its latest state, so the session's older open ones are superseded. */
export function recordWritten(records: Handoffs, path: string, rec: Omit<HandoffRecord, 'status'>): Handoffs {
  const next: Handoffs = {}
  for (const [p, r] of Object.entries(records)) {
    const isOlderOfSession = rec.sessionId !== undefined && r.sessionId === rec.sessionId && r.status === 'open' && p !== path
    next[p] = isOlderOfSession ? { ...r, status: 'superseded' } : r
  }
  next[path] = clean({ ...rec, status: 'open' })
  return newest(next)
}

/** Each listed repo's files as they are on disk; repos not in the listing are left as they were. */
export function mergeListing(records: Handoffs, listing: Readonly<Record<string, readonly { path: string; mtimeMs: number }[]>>): Handoffs {
  const next: Handoffs = {}
  for (const [path, r] of Object.entries(records)) {
    const files = listing[r.repo]
    if (files === undefined || files.some(one => one.path === path)) next[path] = r
  }
  for (const [repo, files] of Object.entries(listing)) {
    for (const one of files) if (next[one.path] === undefined) next[one.path] = { repo, at: one.mtimeMs, status: 'open' }
  }
  return newest(next)
}

export function setStatus(records: Handoffs, path: string, status: HandoffStatus): Handoffs {
  const r = records[path]
  return r === undefined ? records : { ...records, [path]: { ...r, status } }
}

export function resumedBy(text: string, records: Handoffs, home: string | undefined): string[] {
  return Object.entries(records)
    .filter(([path, r]) => r.status === 'open' && (text.includes(path) || text.includes(tildePath(path, home))))
    .map(([path]) => path)
}

export const isStale = (rec: HandoffRecord, now: number) => rec.status === 'open' && now - rec.at > STALE_MS

/** A handoff on disk with no session is another session's: this one would have recorded its own. */
export function bandCount(records: Handoffs, repo: string, sessionId: string | undefined, now: number): number {
  return Object.values(records).filter(r => r.repo === repo && r.status === 'open' && !isStale(r, now) && r.sessionId !== sessionId).length
}

export function handoffRows(records: Handoffs, repo: string | undefined, now: number): { open: HandoffRow[]; closed: HandoffRow[] } {
  const rows = Object.entries(records)
    .filter(([, r]) => repo === undefined || r.repo === repo)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([path, r]) => {
      const reason = r.status !== 'open' ? REASON[r.status] : isStale(r, now) ? 'stale, 14+ days' : undefined
      return { path, repo: r.repo, at: r.at, title: r.title ?? path.split('/').pop()!, ...(reason === undefined ? {} : { reason }) }
    })
  return { open: rows.filter(one => one.reason === undefined), closed: rows.filter(one => one.reason !== undefined) }
}

export function titleOf(markdown: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
  return heading === undefined || heading === '' ? undefined : heading.slice(0, 80)
}
