import type { Lesson, LessonKind, Scope } from '../../types'
import { CONCEPTS, HABITS, SEEN_ENOUGH, byKind } from '../lessons'
import { PRICES_AS_OF } from '../routes'
import { STAMP_W, stamp } from './kit'
import type { Els } from './kit'

type LearnData = {
  lessons: readonly Lesson[]
  isLearning: boolean
  muted: readonly LessonKind[]
  expanded: readonly LessonKind[]
  /** Rows pressed open: `rowId()` of an earlier fact, or `all:<kind>` for every earlier one. */
  rows: readonly string[]
  scope: Scope
  repo: string
}
type LearnActions = {
  setLearning: (isOn: boolean) => void
  setMuted: (kind: LessonKind, isMuted: boolean) => void
  toggle: (kind: LessonKind) => void
  toggleRow: (id: string) => void
  setScope: (scope: Scope) => void
}

const OLDER_SHOWN = 2

const rowId = (one: Lesson) => `${one.kind}:${one.at}`

/**
 * A stamped fact with a hanging indent; an older one is one dim line, since it mostly repeats the latest.
 * Pressing an older one shows it whole; its stamp then folds it.
 *
 * An open fact stays out of the Button: a desktop draws a Button as a native one-line control,
 * so a fact inside it never wraps.
 */
function factRow({ Box, Text, Button }: Els, one: Lesson, isOlder: boolean, showsRepo: boolean, isOpen: boolean, toggleRow: (id: string) => void) {
  const id = rowId(one)
  const isDim = isOlder && !isOpen
  const text = (
    <Text dimColor={isDim} wrap={isDim ? 'truncate-end' : 'wrap'}>
      {showsRepo ? <Text dimColor>{`${one.repo} · `}</Text> : null}
      {one.fact}
    </Text>
  )
  const press = (children: typeof text) => (
    <Button key={`row:${id}`} plain hover={{ underline: true }} onPress={() => toggleRow(id)}>
      {children}
    </Button>
  )
  const when = <Text dimColor>{stamp(one.at)}</Text>
  return (
    <Box key={`f:${id}`} flexDirection="row">
      <Box width={STAMP_W} flexShrink={0}>
        {isOlder && isOpen ? press(when) : when}
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {isDim ? press(text) : text}
      </Box>
    </Box>
  )
}

/** The habits worth keeping whatever the lessons say, boxed apart from them. */
function habitsSection({ Box, Text }: Els) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" borderDimColor paddingX={1} gap={1}>
      <Text bold color="claude">Habits</Text>
      {HABITS.map(one => (
        <Box key={`h:${one.title}`} flexDirection="row" gap={1}>
          <Box width={2} flexShrink={0}>
            <Text color="claude">›</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold>{one.title}</Text>
            <Text dimColor wrap="wrap">{one.body}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

export function learnPaneView(
  els: Els,
  { lessons, isLearning, muted, expanded, rows, scope, repo }: LearnData,
  { setLearning, setMuted, toggle, toggleRow, setScope }: LearnActions,
) {
  const { Box, Text, Button } = els
  const unmuted = lessons.filter(one => !muted.includes(one.kind))
  const shown = scope === 'repo' ? unmuted.filter(one => one.repo === repo) : unmuted
  const elsewhere = unmuted.length - shown.length
  const groups = byKind(shown)
  const showsRepo = new Set(shown.map(one => one.repo)).size > 1
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Learn · {scope === 'repo' ? repo : 'all repos'}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="scope-repo" label="This repo" plain dimColor={scope !== 'repo'} onPress={() => setScope('repo')} />
          <Button key="scope-all" label="All" plain dimColor={scope !== 'all'} onPress={() => setScope('all')} />
        </Box>
      </Box>
      {isLearning ? null : (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Learn mode is off: new cache, model and context costs are not explained.</Text>
          <Button key="learn-on" label="Turn on" plain onPress={() => setLearning(true)} />
        </Box>
      )}
      {groups.length === 0 && elsewhere > 0 ? (
        <Text dimColor>{`No lessons in ${repo} yet; ${elsewhere === 1 ? '1 lesson' : `${elsewhere} lessons`} in other repos under All.`}</Text>
      ) : null}
      {groups.length === 0 && elsewhere === 0 ? (
        <Text dimColor>No lessons yet. They appear when a cache rewrite, a pricey model, a big context or busy subagents cost you something.</Text>
      ) : null}
      {groups.map(([kind, list]) => {
        const isOpen = list.length < SEEN_ENOUGH !== expanded.includes(kind)
        const [latest, ...older] = list
        const isAllShown = rows.includes(`all:${kind}`)
        const hidden = older.length - OLDER_SHOWN
        return (
          <Box key={`k:${kind}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={2}>
              <Box flexShrink={1} minWidth={0}>
                <Text bold>{CONCEPTS[kind].title}</Text>
              </Box>
              <Box flexDirection="row" gap={2} flexShrink={0}>
                <Button key={`why:${kind}`} label={isOpen ? 'hide why' : 'why?'} plain dimColor onPress={() => toggle(kind)} />
                <Button key={`mute:${kind}`} label="mute" plain dimColor onPress={() => setMuted(kind, true)} />
              </Box>
            </Box>
            {factRow(els, latest!, false, showsRepo, true, toggleRow)}
            {older.length === 0 ? null : (
              <Box flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  <Text dimColor>Earlier</Text>
                  {hidden > 0 ? (
                    <Button key={`all:${kind}`} label={isAllShown ? 'show fewer' : `show ${hidden} more`} plain dimColor onPress={() => toggleRow(`all:${kind}`)} />
                  ) : null}
                </Box>
                {(isAllShown ? older : older.slice(0, OLDER_SHOWN)).map(one => factRow(els, one, true, showsRepo, rows.includes(rowId(one)), toggleRow))}
              </Box>
            )}
            {isOpen ? (
              <Box marginTop={1}>
                <Text dimColor italic>{CONCEPTS[kind].body}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      {muted.length === 0 ? null : (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text dimColor>Muted, press to unmute:</Text>
          {muted.map(kind => (
            <Button key={`unmute:${kind}`} label={CONCEPTS[kind].title} plain dimColor onPress={() => setMuted(kind, false)} />
          ))}
        </Box>
      )}
      {habitsSection(els)}
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{`${isLearning ? 'learn mode on' : '/route learn on'} · prices as of ${PRICES_AS_OF}, estimates`}</Text>
        {isLearning ? <Button key="learn-off" label="Turn off" plain dimColor onPress={() => setLearning(false)} /> : null}
      </Box>
    </Box>
  )
}
