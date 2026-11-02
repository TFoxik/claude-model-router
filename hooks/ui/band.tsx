import type { ActiveRoute, Health, RouterConfig } from '../../types'
import { money } from '../core/format'
import { labelOf, shortLabel } from '../core/pricing'
import { resolve, routeText } from '../routing/routes'
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

/** Text only: a desktop draws every Button as a native control, which would break up the line's spacing. */
function healthRowView({ Text }: Els, context: ContextPart | null | undefined, cost: CostPart | null | undefined) {
  if (!context && !cost) return null
  const limits = [['5h', cost?.fiveHour], ['7d', cost?.sevenDay]].filter((one): one is [string, number] => one[1] !== undefined)
  const contextText = context ? (
    <Text key="h-context">
      {'cache '}
      {context.warmMinutes === 0 ? (
        <Text color="error">{context.coldUsd === undefined ? 'cold' : `cold ${money(context.coldUsd)}`}</Text>
      ) : (
        <Text>
          <Text color={context.cache < 50 ? 'error' : context.cache < 80 ? 'warning' : 'success'}>{context.cache}%</Text>{' '}
          <Text color={context.warmMinutes <= 5 ? 'warning' : undefined}>{context.warmMinutes}m</Text>
        </Text>
      )}
      {' · context '}
      <Text color={context.ctxLevel}>{context.ctx}%</Text>
    </Text>
  ) : null
  const costText = cost ? (
    <Text key="h-cost">
      {`last ${money(cost.last)} · session ${money(cost.total)}`}
      {limits.map(([name, pct]) => (
        <Text key={`l:${name}`}>
          {` · ${name} `}
          <Text color={level(pct, 70, 90)}>{pct}%</Text>
        </Text>
      ))}
    </Text>
  ) : null
  return (
    <Text dimColor wrap="truncate-end">
      {contextText}
      {contextText && costText ? ' · ' : null}
      {costText}
    </Text>
  )
}

export type BandHead = { cfg: RouterConfig; now: ActiveRoute | null; pending: RouterConfig | null }
export type ContextPart = Pick<Health, 'cache' | 'warmMinutes' | 'coldUsd' | 'ctx' | 'ctxLevel' | 'advice'>
export type CostPart = { last: number; total: number; fiveHour?: number; sevenDay?: number }

/**
 * What each feature adds to the band. A part left out (`undefined`) is a feature that is off: no segments, no buttons.
 * `null` is a feature that is on with nothing measured yet, which keeps its row and buttons so the band does not grow
 * when the first request is counted.
 */
export type BandParts = { head: BandHead; context?: ContextPart | null; cost?: CostPart | null; handoffsOpen: number }

/**
 * A row only when it has content, so a feature that is off leaves no empty line. The route line and the health row are
 * text across the full width, and every button sits right-aligned on the last row, where a desktop's native button
 * padding can't break the left edge. Returns the rows for the host to put in its column, above whatever other plugins
 * draw. Hiding lives in the Routes pane, away from the buttons pressed every day.
 */
export function bandView(els: Els, { head: { cfg, now, pending }, context, cost, handoffsOpen }: BandParts, { open }: { open: Open }) {
  const { Box, Text, Button } = els
  const rows = [
    <Box key="band-route" flexDirection="row" gap={1}>
      <Text bold={cfg.isEnabled} dimColor={!cfg.isEnabled} color={cfg.isEnabled && now ? colorOf(now.route) : undefined}>
        {bandHead(cfg, now)}
      </Text>
      <Text dimColor wrap="truncate-end">
        │ <Text color="planMode">plan</Text> {shortRoute(cfg, 'plan')} · <Text color="claude">main</Text> {shortRoute(cfg, 'main')} ·{' '}
        <Text color="suggestion">sub</Text> {shortRoute(cfg, 'sub:*')}
      </Text>
      {pending ? <Text color="warning">● draft</Text> : null}
    </Box>,
  ]
  if (context !== undefined || cost !== undefined) {
    rows.push(
      <Box key="band-health" height={1}>
        {healthRowView(els, context, cost)}
      </Box>,
    )
  }
  rows.push(
    <Box key="band-actions" flexDirection="row" justifyContent="flex-end" gap={1}>
      {handoffsOpen > 0 ? <Button key="band-handoffs" label={`Handoffs ●${handoffsOpen}`} plain onPress={() => open('handoffs')} /> : null}
      {context?.advice === undefined ? null : <Button key="advice" label={`next ${context.advice.command}`} variant="primary" onPress={() => open('context')} />}
      {context === undefined ? null : <Button key="ctx" label="Context" plain dimColor onPress={() => open('context')} />}
      {cost === undefined ? null : <Button key="band-cost" label="Cost" plain dimColor onPress={() => open('last')} />}
      <Button key="band-open" label="Routes" plain onPress={() => open('route')} />
    </Box>,
  )
  return rows
}
