import type { PromptRecord, Scope } from '../../types'
import { HISTORY_LIMIT, modelMix, money, plural, statsSummary, sumUsd } from '../routes'
import { ledgerRow, rewriteText } from './kit'
import type { Els, Open } from './kit'

const day = (at: number) => {
  const d = new Date(at)
  return `${d.getDate()}.${d.getMonth() + 1}.`
}

const colorOfLabel = (label: string) => (label === 'prompt' ? 'subtle' : 'suggestion')

const shownText = (r: PromptRecord) => (r.label === 'prompt' ? r.text || 'prompt' : `${r.label} ${r.text.replace(r.label, '').trim()}`.trim())

export function statsFooterView({ Box, Text, Button }: Els, { modes, today }: { modes: readonly string[]; today: number }, { open }: { open: Open }) {
  return (
    <Box flexDirection="row" flexShrink={0}>
      {modes.length > 0 ? <Text dimColor>{`${modes.join(' & ')}  `}</Text> : null}
      <Button key="stats" label={`▤ today ${money(today)}`} plain dimColor onPress={() => open('stats')} />
    </Box>
  )
}

type StatsData = { records: readonly PromptRecord[]; scope: Scope; repo: string; now: number }

export function statsPaneView(els: Els, { records, scope, repo, now }: StatsData, { setScope }: { setScope: (scope: Scope) => void }) {
  const { Box, Text, Button } = els
  const { today, week, rewrites, commands, priciest } = statsSummary(records, now)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Stats · {scope === 'repo' ? repo : 'all repos'}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="scope-repo" label="This repo" plain dimColor={scope !== 'repo'} onPress={() => setScope('repo')} />
          <Button key="scope-all" label="All" plain dimColor={scope !== 'all'} onPress={() => setScope('all')} />
        </Box>
      </Box>
      <Text dimColor>
        today {money(today)} · 7 days {money(week)} · all {money(sumUsd(records))} · {plural(records.length, 'prompt')}
        {rewrites.length > 0 ? ` · ${plural(rewrites.length, 'cache rewrite')} ${money(sumUsd(rewrites))}` : ''}
      </Text>
      {records.length === 0 ? (
        <Text dimColor>Nothing recorded yet.</Text>
      ) : (
        <>
          <Box flexDirection="column">
            <Text bold dimColor>COMMANDS · AVERAGE PER RUN</Text>
            {commands.map(c =>
              ledgerRow(els, {
                key: `c:${c.label}`,
                color: colorOfLabel(c.label),
                name: c.label,
                usd: c.avg,
                sub: [`${plural(c.runs, 'run')} · total ${money(c.total)} · max ${money(c.max)}`, modelMix(c.models, money)],
              }),
            )}
          </Box>
          <Box flexDirection="column">
            <Text bold dimColor>MOST EXPENSIVE PROMPTS</Text>
            {priciest.map((r, i) =>
              ledgerRow(els, {
                key: `p:${i}`,
                color: colorOfLabel(r.label),
                name: shownText(r),
                usd: r.usd,
                sub: [
                  [day(r.at), scope === 'all' ? r.repo : undefined, `${r.requests} req`, plural(r.agents, 'subagent'), ...(r.rewrites ?? []).map(rewriteText)].filter(Boolean).join(' · '),
                  modelMix(r.models, money),
                ],
              }),
            )}
          </Box>
        </>
      )}
      <Text dimColor>estimate · kept across sessions, last {HISTORY_LIMIT} prompts</Text>
    </Box>
  )
}
