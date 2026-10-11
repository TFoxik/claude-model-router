import type { HandoffRecord, HandoffStatus, Handoffs } from '../types'
import { handoffDir, handoffsRoot, tildePath } from './handoff'
import { printable } from './routes'

export type { HandoffRecord, HandoffStatus, Handoffs }
export { handoffDir, handoffsRoot }
export type HandoffRow = { path: string; repo: string; at: number; title: string; gist?: string; isOpen: boolean; reason?: string }

export const STALE_MS = 14 * 86_400_000
const KEPT = 500
const GIST_MAX = 160
const REASON: Record<Exclude<HandoffStatus, 'open'>, string> = { done: 'done', dropped: 'not relevant', resumed: 'resumed', superseded: 'superseded' }
const STATUSES: ReadonlySet<string> = new Set(['open', ...Object.keys(REASON)])

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
    (r.title === undefined || typeof r.title === 'string') &&
    (r.gist === undefined || typeof r.gist === 'string') &&
    (r.reopenedAt === undefined || (typeof r.reopenedAt === 'number' && Number.isFinite(r.reopenedAt)))
  )
}

const clean = ({ repo, at, sessionId, title, gist, status, reopenedAt }: HandoffRecord): HandoffRecord => ({
  repo: printable(repo),
  at,
  ...(sessionId === undefined ? {} : { sessionId }),
  ...(title === undefined ? {} : { title: printable(title) }),
  ...(gist === undefined ? {} : { gist: printable(gist) }),
  status,
  ...(reopenedAt === undefined ? {} : { reopenedAt }),
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

/** Each listed repo's files as they are on disk; repos not in the listing, and handoffs recorded after `listedAt`, are left as they were. */
export function mergeListing(records: Handoffs, listing: Readonly<Record<string, readonly { path: string; mtimeMs: number }[]>>, listedAt: number): Handoffs {
  const isUnchanged =
    Object.entries(records).every(([path, r]) => listing[r.repo] === undefined || r.at > listedAt || listing[r.repo]!.some(one => one.path === path)) &&
    Object.values(listing).every(files => files.every(one => records[one.path] !== undefined))
  if (isUnchanged) return records
  const next: Handoffs = {}
  for (const [path, r] of Object.entries(records)) {
    const files = listing[r.repo]
    if (files === undefined || r.at > listedAt || files.some(one => one.path === path)) next[path] = r
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

/** Reopening restarts the stale clock, or an old handoff would fold straight back. */
export function reopen(records: Handoffs, path: string, now: number): Handoffs {
  const r = records[path]
  return r === undefined ? records : { ...records, [path]: { ...r, status: 'open', reopenedAt: now } }
}

/** The open handoffs `text` names, marked resumed; the same records when it names none. */
export function resumeIn(records: Handoffs, text: string, home: string | undefined): Handoffs {
  return resumedBy(text, records, home).reduce((acc, path) => setStatus(acc, path, 'resumed'), records)
}

export type Details = { title: string; gist: string }

/** Titles and gists read from disk, applied to the records they belong to; the same records when none apply. */
export function withDetails(records: Handoffs, details: Readonly<Record<string, Details>>): Handoffs {
  const known = Object.entries(details).filter(([path]) => records[path] !== undefined)
  return known.length === 0 ? records : { ...records, ...Object.fromEntries(known.map(([path, d]) => [path, clean({ ...records[path]!, ...d })])) }
}

/** What a handoff's text yields for its record: empty strings where it has no title or gist. */
export const detailsOf = (markdown: string): Details => ({ title: titleOf(markdown) ?? '', gist: gistOf(markdown) ?? '' })

export function resumedBy(text: string, records: Handoffs, home: string | undefined): string[] {
  return Object.entries(records)
    .filter(([path, r]) => r.status === 'open' && (text.includes(path) || text.includes(tildePath(path, home))))
    .map(([path]) => path)
}

export const isStale = (rec: HandoffRecord, now: number) => rec.status === 'open' && now - Math.max(rec.at, rec.reopenedAt ?? 0) > STALE_MS

/** A handoff on disk with no session is another session's: this one would have recorded its own. */
export function bandCount(records: Handoffs, repo: string, sessionId: string | undefined, now: number): number {
  return Object.values(records).filter(r => r.repo === repo && r.status === 'open' && !isStale(r, now) && (sessionId === undefined || r.sessionId !== sessionId)).length
}

export function handoffRows(records: Handoffs, repo: string | undefined, now: number): { open: HandoffRow[]; closed: HandoffRow[] } {
  const rows = Object.entries(records)
    .filter(([, r]) => repo === undefined || r.repo === repo)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([path, r]) => {
      const reason = r.status !== 'open' ? REASON[r.status] : isStale(r, now) ? 'stale, 14+ days' : undefined
      return { path, repo: r.repo, at: r.at, title: r.title || path.split('/').pop()!, ...(r.gist ? { gist: r.gist } : {}), isOpen: r.status === 'open', ...(reason === undefined ? {} : { reason }) }
    })
  return { open: rows.filter(one => one.reason === undefined), closed: rows.filter(one => one.reason !== undefined) }
}

export function titleOf(markdown: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim()
  return heading === undefined || heading === '' ? undefined : heading.slice(0, 80)
}

const HEADING = /^#{1,6}\s/
const plain = (line: string) =>
  line
    .replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .trim()

/**
 * What a handoff is about, in a line or two: the first paragraph under its Goal heading, as an auto-handoff writes one,
 * else the first paragraph after the title. Plain text, cut at a word.
 */
export function gistOf(markdown: string): string | undefined {
  const lines = markdown.split('\n')
  const goal = lines.findIndex(line => /^#{2,6}\s+goal\b/i.test(line))
  const start = goal >= 0 ? goal + 1 : lines.findIndex(line => /^#\s/.test(line)) + 1
  const paragraph: string[] = []
  for (const line of lines.slice(start)) {
    if (HEADING.test(line) && (goal >= 0 || paragraph.length > 0)) break
    if (HEADING.test(line) || line.trim() === '') {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(plain(line))
  }
  const text = paragraph.join(' ').replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  if (text.length <= GIST_MAX) return text
  const cut = text.slice(0, GIST_MAX - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}
