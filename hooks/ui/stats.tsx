import type { PromptRecord, Rewrite, Scope } from '../../types'
import { HISTORY_LIMIT, money, plural, statsSummary, sumUsd, typedText } from '../routes'
import { statsTips } from '../tips'
import { DATE_W, day, rewriteText, tipsSection } from './kit'
import type { Els, Open } from './kit'

const colorOfLabel = (label: string) => (label === 'prompt' ? undefined : 'suggestion')

/** Cleans records kept before `typedText` ran at record time too. */
const shownText = (r: PromptRecord) => {
  const text = typedText(r.text)
  return r.label === 'prompt' ? text || 'prompt' : `${r.label} ${text.replace(r.label, '').trim()}`.trim()
}

const MODEL_COLORS: ReadonlyArray<[string, string]> = [
  ['Opus', 'claude'],
  ['Sonnet', 'suggestion'],
  ['Haiku', 'success'],
  ['Fable', 'merged'],
]
const colorOfModel = (model: string) => MODEL_COLORS.find(([prefix]) => model.startsWith(prefix))?.[1] ?? 'subtle'

const BAR_W = 8
const COST_W = 8

/** `share` of BAR_W cells filled; anything above zero shows at least one. */
function bar(share: number) {
  const filled = share > 0 ? Math.max(1, Math.round(share * BAR_W)) : 0
  return { filled: '━'.repeat(filled), empty: '─'.repeat(BAR_W - filled) }
}

export function statsFooterView({ Box, Text, Button }: Els, { modes, today }: { modes: readonly string[]; today: number }, { open }: { open: Open }) {
  return (
    <Box flexDirection="row" flexShrink={0}>
      {modes.length > 0 ? <Text dimColor>{`${modes.join(' & ')}  `}</Text> : null}
      <Button key="stats" label={`▤ today ${money(today)}`} plain dimColor onPress={() => open('history')} />
    </Box>
  )
}

type StatsData = { records: readonly PromptRecord[]; scope: Scope; now: number }

/** The Cost pane's History tab: spend kept across sessions, in the repo or every repo. */
export function historyTabView(els: Els, { records, scope, now }: StatsData) {
  const { Box, Text } = els
  const { today, week, rewrites, commands, priciest } = statsSummary(records, now)
  const topAvg = Math.max(0, ...commands.map(c => c.avg))

  const tile = (key: string, label: string, usd: number, color?: string) => (
    <Box key={key} flexDirection="column">
      <Text dimColor>{label}</Text>
      <Text bold color={color}>{money(usd)}</Text>
    </Box>
  )

  const models = (key: string, mix: Record<string, number> | undefined) => {
    const rows = Object.entries(mix ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
    if (rows.length === 0) return null
    return (
      <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
        {rows.map(([model, usd]) => (
          <Box key={`${key}:${model}`} flexDirection="row" gap={1}>
            <Text color={colorOfModel(model)}>●</Text>
            <Text dimColor>{`${model} ${money(usd)}`}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  const rewriteLines = (key: string, list: readonly Rewrite[] | undefined) =>
    (list ?? []).map((one, i) => (
      <Box key={`${key}:rw${i}`} paddingLeft={2}>
        <Text color="warning">{`↻ ${rewriteText(one)}`}</Text>
      </Box>
    ))

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" columnGap={4} flexWrap="wrap">
          {tile('t:today', 'today', today, 'claude')}
          {tile('t:week', '7 days', week)}
          {tile('t:all', 'all time', sumUsd(records))}
        </Box>
        <Text dimColor>{plural(records.length, 'prompt')}</Text>
        {rewrites.length > 0 ? (
          <Text color="warning">{`↻ ${plural(rewrites.length, 'cache rewrite')} ${money(sumUsd(rewrites))}`}</Text>
        ) : null}
      </Box>

      {records.length === 0 ? (
        <Text dimColor>Nothing recorded yet.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" gap={1}>
            <Text bold dimColor>AVERAGE COST PER RUN</Text>
            {commands.map(c => {
              const { filled, empty } = bar(topAvg > 0 ? c.avg / topAvg : 0)
              return (
                <Box key={`c:${c.label}`} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text color={colorOfLabel(c.label)} bold wrap="truncate-end">{c.label}</Text>
                    </Box>
                    <Box flexShrink={0} flexDirection="row">
                      <Text color="claude">{filled}</Text>
                      <Text dimColor>{empty}</Text>
                    </Box>
                    <Box width={COST_W} flexShrink={0} justifyContent="flex-end">
                      <Text bold>{money(c.avg)}</Text>
                    </Box>
                  </Box>
                  <Box paddingLeft={2}>
                    <Text dimColor>{`${plural(c.runs, 'run')} · total ${money(c.total)} · max ${money(c.max)}`}</Text>
                  </Box>
                  {models(`cm:${c.label}`, c.models)}
                </Box>
              )
            })}
          </Box>

          <Box flexDirection="column" gap={1}>
            <Text bold dimColor>MOST EXPENSIVE PROMPTS</Text>
            {priciest.map((r, i) => (
              <Box key={`p:${i}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Box width={DATE_W} flexShrink={0}>
                    <Text dimColor>{day(r.at)}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text color={colorOfLabel(r.label)} wrap="truncate-end">{shownText(r)}</Text>
                  </Box>
                  <Box width={COST_W} flexShrink={0} justifyContent="flex-end">
                    <Text bold>{money(r.usd)}</Text>
                  </Box>
                </Box>
                <Box paddingLeft={2}>
                  <Text dimColor>
                    {[scope === 'all' ? r.repo : undefined, plural(r.requests, 'request'), r.agents > 0 ? plural(r.agents, 'subagent') : undefined]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Box>
                {models(`pm:${i}`, r.models)}
                {rewriteLines(`p:${i}`, r.rewrites)}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {tipsSection(els, statsTips(records))}

      <Text dimColor>estimate · kept across sessions, last {HISTORY_LIMIT} prompts</Text>
    </Box>
  )
}
