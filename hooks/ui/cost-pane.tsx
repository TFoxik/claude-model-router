import type { CostTab, PromptCost, PromptRecord, RouteSpend, Scope } from '../../types'
import { PRICES_AS_OF, isSub, money, plural, routeLabel, routeText, sumUsd } from '../routes'
import { lastTips } from '../tips'
import { COST_TABS, COST_TAB_LABEL, ledgerRow, rewriteText, shareOf, tipsSection, tokenLine } from './kit'
import type { Els } from './kit'
import { historyTabView } from './stats'

function lastTabView(els: Els, p: PromptCost | null, ttlMinutes: number) {
  const { Box, Text } = els
  if (p === null || p.items.length === 0) return <Text dimColor>No requests in this prompt yet.</Text>
  const main = p.items.filter(one => !isSub(one))
  const subs = p.items.filter(isSub).sort((a, b) => b.usd - a.usd)
  const subTotal = sumUsd(subs)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>Last prompt</Text>
          <Text bold>{money(p.usd)}</Text>
        </Box>
        <Text dimColor>
          {plural(p.requests, 'request')} · main {money(p.usd - subTotal)} · {plural(subs.length, 'subagent')} {money(subTotal)}
        </Text>
      </Box>
      {(p.rewrites ?? []).map((one, i) => (
        <Text key={`rw:${i}`} color="warning">includes a {rewriteText(one)}</Text>
      ))}
      <Box flexDirection="column" gap={1}>
        {[...main, ...subs].map(one =>
          ledgerRow(els, {
            key: `i:${one.id}`,
            route: one.route,
            name: one.label,
            usd: one.usd,
            share: shareOf(one.usd, p.usd),
            sub: [`${routeText(one.model, one.effort)} · ${tokenLine(one)}`],
          }),
        )}
      </Box>
      {tipsSection(els, lastTips(p, ttlMinutes))}
      <Text dimColor>estimate · resets when you send the next prompt</Text>
    </Box>
  )
}

function sessionTabView(els: Els, costs: Record<string, RouteSpend>, ttlMinutes: number) {
  const { Box, Text } = els
  const rows = Object.entries(costs).sort((a, b) => b[1].usd - a[1].usd)
  const total = sumUsd(Object.values(costs))
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>This session, by route</Text>
        <Text bold>{money(total)}</Text>
      </Box>
      {rows.length === 0 ? <Text dimColor>No requests yet.</Text> : null}
      <Box flexDirection="column" gap={1}>
        {rows.map(([route, one]) =>
          ledgerRow(els, {
            key: `s:${route}`,
            route,
            name: routeLabel(route),
            usd: one.usd,
            share: shareOf(one.usd, total),
            sub: [tokenLine(one)],
          }),
        )}
      </Box>
      <Text dimColor>estimate · prices as of {PRICES_AS_OF} · cache writes at the {ttlMinutes === 60 ? '1-hour (2× input)' : '5-minute (1.25× input)'} rate</Text>
    </Box>
  )
}

type CostData = {
  tab: CostTab
  lastPrompt: PromptCost | null
  costs: Record<string, RouteSpend>
  records: readonly PromptRecord[]
  scope: Scope
  repo: string
  now: number
  ttlMinutes: number
}
type CostActions = { setTab: (tab: CostTab) => void; setScope: (scope: Scope) => void }

/** Last prompt, this session and the history kept across sessions, one tab at a time. */
export function costPaneView(els: Els, data: CostData, { setTab, setScope }: CostActions) {
  const { Box, Text, Button } = els
  const { tab, scope } = data
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">{tab === 'history' ? `Cost · ${scope === 'repo' ? data.repo : 'all repos'}` : 'Cost'}</Text>
        {tab === 'history' ? (
          <Box flexDirection="row" gap={1}>
            <Button key="scope-repo" label="This repo" plain dimColor={scope !== 'repo'} onPress={() => setScope('repo')} />
            <Button key="scope-all" label="All" plain dimColor={scope !== 'all'} onPress={() => setScope('all')} />
          </Box>
        ) : null}
      </Box>
      <Box flexDirection="row" gap={1}>
        {COST_TABS.map(one => (
          <Button key={`tab-${one}`} label={COST_TAB_LABEL[one]} variant={one === tab ? 'primary' : 'secondary'} onPress={() => setTab(one)} />
        ))}
      </Box>
      {tab === 'last' ? lastTabView(els, data.lastPrompt, data.ttlMinutes) : null}
      {tab === 'session' ? sessionTabView(els, data.costs, data.ttlMinutes) : null}
      {tab === 'history' ? historyTabView(els, { records: data.records, scope, now: data.now }) : null}
    </Box>
  )
}
