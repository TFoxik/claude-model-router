import { expect, test } from 'claude-code/testing'

import { STALE_MS, bandCount, closeMarked, handoffDir, handoffRows, isStale, mergeListing, recordWritten, repoOfHandoff, resumedBy, sanitizeHandoffs, setStatus, detailsOf, gistOf, stepsOf, titleOf, withDetails } from './handoffs'
import type { Handoffs } from './handoffs'

const HOME = '/home/me'
const dir = handoffDir(HOME, 'app')
const T0 = Date.parse('2026-10-11T10:00:00Z')
const DAY = 86_400_000

test('a handoff path names its repo folder; anything else is not a handoff', () => {
  expect(dir).toBe('/home/me/.claude/handoffs/app')
  expect(repoOfHandoff(`${dir}/2026-10-11-1000-abc.md`, HOME)).toBe('app')
  expect(repoOfHandoff(`${dir}/notes.txt`, HOME)).toBeUndefined()
  expect(repoOfHandoff(`${dir}/deeper/x.md`, HOME)).toBeUndefined()
  expect(repoOfHandoff('/tmp/x.md', HOME)).toBeUndefined()
  expect(repoOfHandoff(`${dir}/x.md`, undefined)).toBeUndefined()
  expect(repoOfHandoff(`${HOME}/.claude/handoffs/../x.md`, HOME)).toBeUndefined()
  expect(repoOfHandoff(`${HOME}/.claude/handoffs/./x.md`, HOME)).toBeUndefined()
})

test('a new handoff supersedes the open ones of its session, and only those', () => {
  const start: Handoffs = {
    [`${dir}/a.md`]: { repo: 'app', at: T0, sessionId: 's1', status: 'open' },
    [`${dir}/b.md`]: { repo: 'app', at: T0, sessionId: 's2', status: 'open' },
    [`${dir}/c.md`]: { repo: 'app', at: T0, sessionId: 's1', status: 'done' },
    [`${dir}/d.md`]: { repo: 'app', at: T0, status: 'open' },
  }
  const next = recordWritten(start, `${dir}/e.md`, { repo: 'app', at: T0 + 1, sessionId: 's1', title: 'E' })
  expect(next[`${dir}/a.md`]!.status).toBe('superseded')
  expect(next[`${dir}/b.md`]!.status).toBe('open')
  expect(next[`${dir}/c.md`]!.status).toBe('done')
  expect(next[`${dir}/d.md`]!.status).toBe('open')
  expect(next[`${dir}/e.md`]).toEqual({ repo: 'app', at: T0 + 1, sessionId: 's1', title: 'E', status: 'open' })
})

test('writing the same path again replaces it and stays open', () => {
  const once = recordWritten({}, `${dir}/a.md`, { repo: 'app', at: T0, sessionId: 's1' })
  const twice = recordWritten(once, `${dir}/a.md`, { repo: 'app', at: T0 + 5, sessionId: 's1', title: 'A' })
  expect(twice).toEqual({ [`${dir}/a.md`]: { repo: 'app', at: T0 + 5, sessionId: 's1', title: 'A', status: 'open' } })
})

test('a listing adds unseen files as open, forgets missing ones of that repo, and leaves other repos alone', () => {
  const other = `${handoffDir(HOME, 'other')}/x.md`
  const start: Handoffs = {
    [`${dir}/gone.md`]: { repo: 'app', at: T0, status: 'done' },
    [`${dir}/kept.md`]: { repo: 'app', at: T0, status: 'dropped' },
    [other]: { repo: 'other', at: T0, status: 'open' },
  }
  const next = mergeListing(start, { app: [{ path: `${dir}/kept.md`, mtimeMs: T0 + 9 }, { path: `${dir}/new.md`, mtimeMs: T0 + 7 }] }, T0 + 100)
  expect(Object.keys(next).sort()).toEqual([`${dir}/kept.md`, `${dir}/new.md`, other].sort())
  expect(next[`${dir}/kept.md`]).toEqual({ repo: 'app', at: T0, status: 'dropped' })
  expect(next[`${dir}/new.md`]).toEqual({ repo: 'app', at: T0 + 7, status: 'open' })
  expect(next[other]).toEqual(start[other])
})

test('a prompt resumes the open handoffs whose full or ~/ path it contains', () => {
  const records: Handoffs = {
    [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open' },
    [`${dir}/b.md`]: { repo: 'app', at: T0, status: 'open' },
    [`${dir}/c.md`]: { repo: 'app', at: T0, status: 'done' },
  }
  expect(resumedBy(`resume from ${dir}/a.md`, records, HOME)).toEqual([`${dir}/a.md`])
  expect(resumedBy('resume from ~/.claude/handoffs/app/b.md please', records, HOME)).toEqual([`${dir}/b.md`])
  expect(resumedBy(`resume from ${dir}/c.md`, records, HOME)).toEqual([])
  expect(resumedBy('carry on', records, HOME)).toEqual([])
})

test('setStatus changes a known handoff and ignores an unknown path', () => {
  const records: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open' } }
  expect(setStatus(records, `${dir}/a.md`, 'done')[`${dir}/a.md`]!.status).toBe('done')
  expect(setStatus(records, `${dir}/zz.md`, 'done')).toEqual(records)
})

test('an open handoff goes stale after 14 days; a closed one never does', () => {
  expect(STALE_MS).toBe(14 * DAY)
  expect(isStale({ repo: 'app', at: T0, status: 'open' }, T0 + STALE_MS)).toBe(false)
  expect(isStale({ repo: 'app', at: T0, status: 'open' }, T0 + STALE_MS + 1)).toBe(true)
  expect(isStale({ repo: 'app', at: T0, status: 'done' }, T0 + 30 * DAY)).toBe(false)
})

test('the band counts open, fresh handoffs of this repo from other sessions', () => {
  const records: Handoffs = {
    [`${dir}/mine.md`]: { repo: 'app', at: T0, sessionId: 'me', status: 'open' },
    [`${dir}/theirs.md`]: { repo: 'app', at: T0, sessionId: 'them', status: 'open' },
    [`${dir}/disk.md`]: { repo: 'app', at: T0, status: 'open' },
    [`${dir}/old.md`]: { repo: 'app', at: T0 - 20 * DAY, sessionId: 'them', status: 'open' },
    [`${dir}/done.md`]: { repo: 'app', at: T0, sessionId: 'them', status: 'done' },
    [`${handoffDir(HOME, 'other')}/x.md`]: { repo: 'other', at: T0, status: 'open' },
  }
  expect(bandCount(records, 'app', 'me', T0)).toBe(2)
})

test('rows: open ones newest first, stale and closed ones folded with their reason', () => {
  const records: Handoffs = {
    [`${dir}/old-open.md`]: { repo: 'app', at: T0 - 20 * DAY, title: 'Old', status: 'open' },
    [`${dir}/a.md`]: { repo: 'app', at: T0 - 2, title: 'A', status: 'open' },
    [`${dir}/b.md`]: { repo: 'app', at: T0 - 1, status: 'open' },
    [`${dir}/d.md`]: { repo: 'app', at: T0 - 3, title: 'D', status: 'dropped' },
    [`${dir}/s.md`]: { repo: 'app', at: T0 - 4, title: 'S', status: 'superseded' },
    [`${handoffDir(HOME, 'other')}/x.md`]: { repo: 'other', at: T0, title: 'X', status: 'open' },
  }
  const here = handoffRows(records, 'app', T0)
  expect(here.open.map(r => r.title)).toEqual(['b.md', 'A'])
  expect(here.closed.map(r => [r.title, r.reason])).toEqual([['D', 'not relevant'], ['S', 'superseded'], ['Old', 'stale, 14+ days']])
  expect(handoffRows(records, undefined, T0).open.map(r => r.title)).toEqual(['X', 'b.md', 'A'])
})

test('the title is the first # heading, cut to 80 characters', () => {
  expect(titleOf('intro\n# Handoff: fix the band\n## Goal')).toBe('Handoff: fix the band')
  expect(titleOf(`# ${'x'.repeat(100)}`)).toHaveLength(80)
  expect(titleOf('## Only a subheading')).toBeUndefined()
})

test('the gist is the first paragraph under Goal, as plain text', () => {
  const md = '# Handoff: fix the band\n\n## Done\n- nothing yet\n\n## Goal\nMake the **band** three lines in `band.tsx`,\nsee [the issue](https://x.test/1).\n\nSecond paragraph.\n## Open steps\n1. one'
  expect(gistOf(md)).toBe('Make the band three lines in band.tsx, see the issue.')
})

test('without a Goal, the gist is the first paragraph after the title; none without a body', () => {
  expect(gistOf('# Title\n\n- first point\n- second point\n\nmore')).toBe('first point second point')
  expect(gistOf('intro line\n# Title\n## Context\n> quoted why\n')).toBe('quoted why')
  expect(gistOf('# Title only\n\n## Empty\n')).toBeUndefined()
  expect(gistOf('')).toBeUndefined()
})

test('the mtime a handoff was read at survives the store', () => {
  const records = sanitizeHandoffs({ [`${dir}/a.md`]: { repo: 'app', at: T0, readMtimeMs: T0 - 5, status: 'open' } })
  expect(records[`${dir}/a.md`]).toEqual({ repo: 'app', at: T0, readMtimeMs: T0 - 5, status: 'open' })
  expect(sanitizeHandoffs({ [`${dir}/b.md`]: { repo: 'app', at: T0, readMtimeMs: 'x', status: 'open' } })).toEqual({})
})

test('a long gist is cut at a word, under 320 characters, with an ellipsis', () => {
  expect(gistOf(`## Goal\n${'word '.repeat(60)}`)).toBe('word '.repeat(60).trim())
  const gist = gistOf(`## Goal\n${'word '.repeat(80)}`)!
  expect(gist.length).toBeLessThanOrEqual(320)
  expect(gist.endsWith('word…')).toBe(true)
})

test('details read from disk fill title and gist; an empty gist is kept', () => {
  const records: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, title: 'Kept', status: 'open' } }
  const next = withDetails(records, { [`${dir}/a.md`]: { title: 'A', gist: 'Why\u0007it matters' }, [`${dir}/gone.md`]: { title: 'X', gist: '' } })
  expect(next).toEqual({ [`${dir}/a.md`]: { repo: 'app', at: T0, title: 'A', gist: 'Why it matters', status: 'open' } })
  expect(withDetails(records, {})).toBe(records)
  expect(sanitizeHandoffs(next)).toEqual(next)
  expect(handoffRows(next, 'app', T0).open[0]!.gist).toBe('Why it matters')
})

test('stored handoffs keep only well-formed records, the newest 500', () => {
  const raw = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`${dir}/${i}.md`, { repo: 'app', at: T0 + i, status: 'open', junk: 1 }]))
  const kept = sanitizeHandoffs({ ...raw, bad: { repo: 'app', at: 'x', status: 'open' }, worse: { repo: 'app', at: 1, status: 'maybe' } })
  expect(Object.keys(kept)).toHaveLength(500)
  expect(kept[`${dir}/509.md`]).toEqual({ repo: 'app', at: T0 + 509, status: 'open' })
  expect(kept[`${dir}/0.md`]).toBeUndefined()
  expect(sanitizeHandoffs(null)).toEqual({})
  expect(sanitizeHandoffs([1, 2])).toEqual({})
})

test('a listing keeps a handoff recorded after the folder was read', () => {
  const start: Handoffs = { [`${dir}/fresh.md`]: { repo: 'app', at: T0 + 10, sessionId: 's1', status: 'open' } }
  expect(mergeListing(start, { app: [] }, T0)).toEqual(start)
  expect(mergeListing(start, { app: [] }, T0 + 20)).toEqual({})
})

test('without a session id, handoffs on disk still count toward the band', () => {
  const records: Handoffs = { [`${dir}/disk.md`]: { repo: 'app', at: T0, status: 'open' } }
  expect(bandCount(records, 'app', undefined, T0)).toBe(1)
})

test('a file with no heading keeps an empty title, shown as its file name', () => {
  const records: Handoffs = { [`${dir}/plain.md`]: { repo: 'app', at: T0, title: '', status: 'open' } }
  expect(handoffRows(records, 'app', T0).open.map(r => r.title)).toEqual(['plain.md'])
})

test('a closed marker beside an open handoff marks it done', () => {
  const records: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open' } }
  expect(closeMarked(records, { [`${dir}/a.md`]: T0 + DAY })[`${dir}/a.md`]!.status).toBe('done')
})

test('a reopen after the marker keeps the handoff open; one before it does not', () => {
  const after: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open', reopenedAt: T0 + 2 * DAY } }
  expect(closeMarked(after, { [`${dir}/a.md`]: T0 + DAY })).toBe(after)
  const before: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open', reopenedAt: T0 + DAY } }
  expect(closeMarked(before, { [`${dir}/a.md`]: T0 + 2 * DAY })[`${dir}/a.md`]!.status).toBe('done')
})

test('without a marker nothing changes', () => {
  const records: Handoffs = { [`${dir}/a.md`]: { repo: 'app', at: T0, status: 'open' } }
  expect(closeMarked(records, {})).toBe(records)
  expect(closeMarked(records, { [`${dir}/other.md`]: T0 })).toBe(records)
})

test('a marker leaves resumed and superseded handoffs as they are', () => {
  const records: Handoffs = {
    [`${dir}/r.md`]: { repo: 'app', at: T0, status: 'resumed' },
    [`${dir}/s.md`]: { repo: 'app', at: T0, status: 'superseded' },
  }
  expect(closeMarked(records, { [`${dir}/r.md`]: T0 + DAY, [`${dir}/s.md`]: T0 + DAY })).toBe(records)
})

const STEPS_MD = `# Handoff
## Goal
Ship it.
## Open steps, in order
1. **Tests.** Run the \`suite\`.
   - a sub-step that is not shown
2) (you) click through the panes
- (claude) write the [docs](x.md)
### A deeper heading stays in the section
* fourth

5. fifth
## Files
1. not a step
`

test('the open steps are the top-level items under the first Open steps heading, as plain text', () => {
  expect(stepsOf(STEPS_MD)).toEqual(['Tests. Run the suite.', '(you) click through the panes', '(claude) write the docs', 'fourth', 'fifth'])
  expect(stepsOf('# T\n### open steps\n1. lower case, any level\n## Next\n1. no')).toEqual(['lower case, any level'])
  expect(stepsOf('# T\n## Goal\n1. not steps')).toEqual([])
  expect(stepsOf('')).toEqual([])
})

test('a long step is cut at a word, with an ellipsis', () => {
  const [step] = stepsOf(`## Open steps\n1. ${'word '.repeat(40)}`)
  expect(step!.length).toBeLessThanOrEqual(120)
  expect(step!.endsWith('word…')).toBe(true)
})

test('details keep the first six steps and count them all', () => {
  const md = `# T\n## Open steps\n${Array.from({ length: 8 }, (_, i) => `${i + 1}. s${i + 1}`).join('\n')}`
  expect(detailsOf(md)).toEqual({ title: 'T', gist: '', steps: ['s1', 's2', 's3', 's4', 's5', 's6'], stepCount: 8 })
  expect(detailsOf('no heading')).toEqual({ title: '', gist: 'no heading', steps: [], stepCount: 0 })
})

test('steps survive the store and reach the rows', () => {
  const records = sanitizeHandoffs({ [`${dir}/a.md`]: { repo: 'app', at: T0, title: 'A', gist: '', steps: ['one\u0007', 'two'], stepCount: 3, status: 'open' } })
  expect(records[`${dir}/a.md`]).toEqual({ repo: 'app', at: T0, title: 'A', gist: '', steps: ['one ', 'two'], stepCount: 3, status: 'open' })
  expect(sanitizeHandoffs({ [`${dir}/b.md`]: { repo: 'app', at: T0, steps: [1], status: 'open' } })).toEqual({})
  const row = handoffRows(records, 'app', T0).open[0]!
  expect([row.steps, row.stepCount]).toEqual([['one ', 'two'], 3])
})
