import type { PromptCost } from '../../types'
import { isSub, money, plural, routeText, sumUsd } from '../routes'
import { lastTips } from '../tips'
import { ledgerRow, rewriteText, shareOf, tipsSection, tokenLine } from './kit'
import type { Els } from './kit'

export function lastPaneView(els: Els, p: PromptCost | null, ttlMinutes: number) {
  const { Box, Text } = els
  if (p === null || p.items.length === 0) return <Text dimColor>No requests in this prompt yet.</Text>
  const main = p.items.filter(one => !isSub(one))
  const subs = p.items.filter(isSub).sort((a, b) => b.usd - a.usd)
  const subTotal = sumUsd(subs)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Last prompt</Text>
        <Text bold>{money(p.usd)}</Text>
      </Box>
      <Text dimColor>
        {plural(p.requests, 'request')} · main {money(p.usd - subTotal)} · {plural(subs.length, 'subagent')} {money(subTotal)}
      </Text>
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
