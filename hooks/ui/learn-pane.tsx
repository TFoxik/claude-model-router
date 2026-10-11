import type { Lesson, LessonKind, Scope } from '../../types'
import { CONCEPTS, HABITS, SEEN_ENOUGH, byKind } from '../lessons'
import { PRICES_AS_OF } from '../routes'
import { DATE_W, day } from './kit'
import type { Els } from './kit'

type LearnData = { lessons: readonly Lesson[]; isLearning: boolean; muted: readonly LessonKind[]; expanded: readonly LessonKind[]; scope: Scope; repo: string }
type LearnActions = {
  setLearning: (isOn: boolean) => void
  setMuted: (kind: LessonKind, isMuted: boolean) => void
  toggle: (kind: LessonKind) => void
  setScope: (scope: Scope) => void
}

const OLDER_SHOWN = 2

/** A dated fact with a hanging indent; an older one is one dim line, since it mostly repeats the latest. */
function factRow({ Box, Text }: Els, key: string, one: Lesson, isOlder: boolean, showsRepo: boolean) {
  return (
    <Box key={key} flexDirection="row">
      <Box width={DATE_W} flexShrink={0}>
        <Text dimColor>{day(one.at)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text dimColor={isOlder} wrap={isOlder ? 'truncate-end' : 'wrap'}>
          {showsRepo ? <Text dimColor>{`${one.repo} · `}</Text> : null}
          {one.fact}
        </Text>
      </Box>
    </Box>
  )
}

export function learnPaneView(
  els: Els,
  { lessons, isLearning, muted, expanded, scope, repo }: LearnData,
  { setLearning, setMuted, toggle, setScope }: LearnActions,
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
            {factRow(els, `l:${kind}`, latest!, false, showsRepo)}
            {older.length === 0 ? null : (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>{older.length > OLDER_SHOWN ? `Earlier, ${older.length - OLDER_SHOWN} more not shown` : 'Earlier'}</Text>
                {older.slice(0, OLDER_SHOWN).map((one, i) => factRow(els, `o:${kind}:${i}`, one, true, showsRepo))}
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
      <Box flexDirection="column">
        <Text bold>Habits</Text>
        {HABITS.map(one => (
          <Text key={`h:${one.title}`} wrap="wrap">
            <Text color="claude">{one.title}</Text>
            <Text dimColor>{` · ${one.body}`}</Text>
          </Text>
        ))}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{`${isLearning ? 'learn mode on' : '/route learn on'} · prices as of ${PRICES_AS_OF}, estimates`}</Text>
        {isLearning ? <Button key="learn-off" label="Turn off" plain dimColor onPress={() => setLearning(false)} /> : null}
      </Box>
    </Box>
  )
}
