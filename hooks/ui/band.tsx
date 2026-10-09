import type { ActiveRoute, Health, RouterConfig } from '../../types'
import { labelOf, money, resolve, routeText, shortLabel } from '../routes'
import { colorOf } from './kit'
import type { Els, Open } from './kit'

const level = (value: number, warn: number, bad: number) => (value >= bad ? 'error' : value >= warn ? 'warning' : undefined)

const shortRoute = (cfg: RouterConfig, route: string) => {
  const r = resolve(cfg, route)
  return `${r.model ? shortLabel(labelOf(r.model)) : 'inherit'}${r.effort ? ` ${r.effort}` : ''}`
}

function bandHead(cfg: RouterConfig, now: ActiveRoute | null): string {
  if (!cfg.isEnabled) return 'router off'
  if (now === null) return '▸ waiting for first request'
  return `▸ ${now.route} · ${routeText(now.model, now.effort)}${now.isHeld ? ' (held)' : ''}`
}

function healthRowView({ Box, Text, Button }: Els, health: Health | null, open: Open) {
  if (health === null) return null
  const cacheColor = health.cache < 50 ? 'error' : health.cache < 80 ? 'warning' : 'success'
  const limits = [['5h', health.fiveHour], ['7d', health.sevenDay]].filter((one): one is [string, number] => one[1] !== undefined)
  return (
    <Box flexDirection="row">
      <Text dimColor>
        {'cache '}
        {health.warmMinutes === 0 ? (
          <Text color="error">{health.coldUsd === undefined ? 'cold' : `cold ${money(health.coldUsd)}`}</Text>
        ) : (
          <Text>
            <Text color={cacheColor}>{health.cache}%</Text>{' '}
            <Text color={health.warmMinutes <= 5 ? 'warning' : undefined}>{health.warmMinutes}m</Text>
          </Text>
        )}
        {'  ·  '}
      </Text>
      <Button key="ctx" label="context" plain dimColor onPress={() => open('context')} />
      <Text dimColor>
        {' '}
        <Text color={health.ctxLevel}>{health.ctx}%</Text>
        {'  ·  '}
      </Text>
      <Button key="last-cost" label={`last ${money(health.last)}`} plain dimColor onPress={() => open('last')} />
      {limits.length === 0 ? null : (
        <Text dimColor>
          {limits.map(([name, pct]) => (
            <Text key={`l:${name}`}>
              {`  ·  ${name} `}
              <Text color={level(pct, 70, 90)}>{pct}%</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  )
}

type BandData = { cfg: RouterConfig; now: ActiveRoute | null; pending: RouterConfig | null; total: number; health: Health | null; learnUnread: number }

export function bandView(els: Els, { cfg, now, pending, total, health, learnUnread }: BandData, { open, hide }: { open: Open; hide: () => void }) {
  const { Box, Text, Button } = els
  return (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="column" flexShrink={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold={cfg.isEnabled} dimColor={!cfg.isEnabled} color={cfg.isEnabled && now ? colorOf(now.route) : undefined}>
            {bandHead(cfg, now)}
          </Text>
          <Text dimColor wrap="truncate-end">
            │ <Text color="planMode">plan</Text> {shortRoute(cfg, 'plan')} · <Text color="claude">main</Text> {shortRoute(cfg, 'main')} ·{' '}
            <Text color="suggestion">sub</Text> {shortRoute(cfg, 'sub:*')} · {money(total)}
          </Text>
          {pending ? <Text color="warning">● draft</Text> : null}
        </Box>
        {healthRowView(els, health, open)}
      </Box>
      <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
        {learnUnread > 0 ? <Button key="band-learn" label={`Learn ●${learnUnread}`} plain onPress={() => open('learn')} /> : null}
        <Button key="band-open" label="Routes" plain onPress={() => open('route')} />
        <Button key="band-hide" label="Hide" plain onPress={hide} />
      </Box>
    </Box>
  )
}
