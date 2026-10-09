import type { Lesson, LessonKind } from '../../types'
import { CONCEPTS, SEEN_ENOUGH, byKind } from '../lessons'
import { PRICES_AS_OF } from '../routes'
import { day } from './kit'
import type { Els } from './kit'

type LearnData = { lessons: readonly Lesson[]; isLearning: boolean; muted: readonly LessonKind[]; expanded: readonly LessonKind[] }
type LearnActions = { setLearning: (isOn: boolean) => void; setMuted: (kind: LessonKind, isMuted: boolean) => void; toggle: (kind: LessonKind) => void }

const OLDER_SHOWN = 2

export function learnPaneView(els: Els, { lessons, isLearning, muted, expanded }: LearnData, { setLearning, setMuted, toggle }: LearnActions) {
  const { Box, Text, Button } = els
  const groups = byKind(lessons.filter(one => !muted.includes(one.kind)))
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="claude">Learn</Text>
      {isLearning ? null : (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>Learn mode is off: new cache, model and context costs are not explained.</Text>
          <Button key="learn-on" label="Turn on" plain onPress={() => setLearning(true)} />
        </Box>
      )}
      {groups.length === 0 ? <Text dimColor>No lessons yet. They appear when a cache rewrite, a pricey model, a big context or busy subagents cost you something.</Text> : null}
      {groups.map(([kind, list]) => {
        const isOpen = list.length < SEEN_ENOUGH !== expanded.includes(kind)
        const [latest, ...older] = list
        return (
          <Box key={`k:${kind}`} flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>{CONCEPTS[kind].title}</Text>
              <Box flexDirection="row" gap={1}>
                <Button key={`why:${kind}`} label={isOpen ? 'hide why' : 'why?'} plain dimColor onPress={() => toggle(kind)} />
                <Button key={`mute:${kind}`} label="mute" plain dimColor onPress={() => setMuted(kind, true)} />
              </Box>
            </Box>
            {isOpen ? <Text dimColor>{CONCEPTS[kind].body}</Text> : null}
            <Text>{`${day(latest!.at)}  ${latest!.fact}`}</Text>
            {older.slice(0, OLDER_SHOWN).map((one, i) => (
              <Text key={`o:${kind}:${i}`} dimColor>{`${day(one.at)}  ${one.fact}`}</Text>
            ))}
            {older.length > OLDER_SHOWN ? <Text dimColor>{`+${older.length - OLDER_SHOWN} earlier`}</Text> : null}
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
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{`${isLearning ? 'learn mode on' : '/route learn on'} · prices as of ${PRICES_AS_OF}, estimates`}</Text>
        {isLearning ? <Button key="learn-off" label="Turn off" plain dimColor onPress={() => setLearning(false)} /> : null}
      </Box>
    </Box>
  )
}
