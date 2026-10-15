import type { LearnCard } from '../../types'
import { CONCEPTS } from '../lessons'
import type { Els } from './kit'

type CardActions = { dismiss: () => void; mute: () => void }

/** The lesson of the turn just ended, above the band until the next prompt; the concept only the first time. */
export function learnCardView({ Box, Text, Button }: Els, card: LearnCard, { dismiss, mute }: CardActions) {
  const { title, body } = CONCEPTS[card.kind]
  return (
    <Box key="learn-card" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Box key="learn-card-title" flexShrink={1} minWidth={0}>
          <Text bold color="suggestion" wrap="truncate-end">{`📚 ${title}`}</Text>
        </Box>
        {card.more > 0 ? (
          <Box key="learn-card-more" flexShrink={0}>
            <Text dimColor>{`+${card.more} more`}</Text>
          </Box>
        ) : null}
      </Box>
      <Box key="learn-card-fact">
        <Text wrap="wrap">{card.fact}</Text>
      </Box>
      {card.isFirst ? (
        <Box key="learn-card-body">
          <Text dimColor wrap="wrap">{body}</Text>
        </Box>
      ) : null}
      <Box flexDirection="row" justifyContent="flex-end" gap={2}>
        <Button key="learn-got" label="Got it" hotkey="g" variant="primary" onPress={dismiss} />
        <Button key="learn-mute" label="Mute topic" hotkey="m" onPress={mute} />
      </Box>
    </Box>
  )
}
