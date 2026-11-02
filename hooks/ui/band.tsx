import type { RenderChildren } from 'claude-code'

import type { ActiveRoute, RouterConfig } from '../../types'
import { labelOf, shortLabel } from '../core/pricing'
import { resolve, routeText } from '../routing/routes'
import { colorOf } from './kit'
import type { Els, Open, Target } from './kit'

const shortRoute = (cfg: RouterConfig, route: string) => {
  const r = resolve(cfg, route)
  return `${r.model ? shortLabel(labelOf(r.model)) : 'inherit'}${r.effort ? ` ${r.effort}` : ''}`
}

function bandHead(cfg: RouterConfig, now: ActiveRoute | null): string {
  if (!cfg.isEnabled) return 'router off'
  if (now === null) return '▸ waiting for first request'
  return `▸ ${now.route} · ${routeText(now.model, now.effort)}${now.isHeld ? ' (held)' : ''}`
}

export type BandHead = { cfg: RouterConfig; now: ActiveRoute | null; pending: RouterConfig | null }

export type BandButton = { key: string; label: string; target: Target; look: 'plain' | 'dim' | 'primary' }

/**
 * `segment` is `null` while nothing is measured yet, which keeps the row so the band does not grow when the first request is counted.
 */
export type BandPart = { segment?: (els: Els) => RenderChildren | null; buttons: readonly BandButton[] }

/** Text only: a desktop draws every Button as a native control, which would break up the line's spacing. */
function healthRowView(els: Els, parts: readonly BandPart[]) {
  const { Text } = els
  const drawn = parts.flatMap(one => {
    const node = one.segment?.(els)
    return node === undefined || node === null ? [] : [node]
  })
  if (drawn.length === 0) return null
  return <Text dimColor wrap="truncate-end">{drawn.flatMap((node, i) => (i === 0 ? [node] : [' · ', node]))}</Text>
}

const buttonView = ({ Button }: Els, b: BandButton, open: Open) =>
  b.look === 'primary' ? (
    <Button key={b.key} label={b.label} variant="primary" onPress={() => open(b.target)} />
  ) : (
    <Button key={b.key} label={b.label} plain dimColor={b.look === 'dim'} onPress={() => open(b.target)} />
  )

/**
 * Every button sits right-aligned on the last row, where a desktop's native button padding can't break the left edge.
 * Hiding lives in the Routes pane, away from the buttons pressed every day.
 */
export function bandView(els: Els, { head: { cfg, now, pending }, parts }: { head: BandHead; parts: readonly BandPart[] }, { open }: { open: Open }) {
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
  if (parts.some(one => one.segment !== undefined)) {
    rows.push(
      <Box key="band-health" height={1}>
        {healthRowView(els, parts)}
      </Box>,
    )
  }
  rows.push(
    <Box key="band-actions" flexDirection="row" justifyContent="flex-end" gap={1}>
      {parts.flatMap(one => one.buttons).map(b => buttonView(els, b, open))}
      <Button key="band-open" label="Routes" plain onPress={() => open('route')} />
    </Box>,
  )
  return rows
}
