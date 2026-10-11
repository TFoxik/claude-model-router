import type { EngineInterface } from 'claude-code'

import type { Rewrite, RouteSpend } from '../../types'
import { kTokens, money } from '../routes'
import type { Tip } from '../tips'

export const PANES = {
  route: { id: 'model-router', title: 'Model router' },
  stats: { id: 'model-router-stats', title: 'Stats' },
  context: { id: 'model-router-ctx', title: 'Context' },
  last: { id: 'model-router-last', title: 'Last prompt cost' },
  learn: { id: 'model-router-learn', title: 'Learn' },
} as const

/** Opens a pane by name; the view gets it from the hooks module, which holds `$`. */
export type Open = (pane: keyof typeof PANES) => void

export type Els = ReturnType<EngineInterface['ui']['resolve']>

/** `9.10.`: a short local date for a timestamp. */
export const day = (at: number) => {
  const d = new Date(at)
  return `${d.getDate()}.${d.getMonth() + 1}.`
}

/** Columns for a `day()` gutter: the widest date and a space. */
export const DATE_W = 7

/** `9.10. 14:05`: `day()` with the local time. */
export const stamp = (at: number) => {
  const d = new Date(at)
  return `${day(at)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Columns for a `stamp()` gutter: the widest stamp and a space. */
export const STAMP_W = 13

const ROUTE_COLOR: Record<string, string> = { plan: 'planMode', main: 'claude' }
export const colorOf = (route: string) => ROUTE_COLOR[route] ?? 'suggestion'

const CAUSE_LABEL: Record<Rewrite['cause'], string> = { cold: 'cold cache', switch: 'route switch' }

export const rewriteText = (one: Rewrite) => `${CAUSE_LABEL[one.cause]} rewrite of ${kTokens(one.tokens)} tokens, ${money(one.usd)}`

export const tokenLine = (one: RouteSpend) =>
  `${one.requests} req · in ${kTokens(one.input)} · cache ${kTokens(one.cacheRead)}/${kTokens(one.cacheWrite)} · out ${kTokens(one.output)}`

type Row = {
  key: string
  name: string
  usd: number
  /** Colours the dot and the name by route; `color` alone colours only the dot. */
  route?: string
  color?: string
  share?: number
  sub?: ReadonlyArray<string | undefined>
}

/** A pane row: a coloured dot, a name that truncates, the cost right-aligned, an optional share and dim sub-lines. */
export function ledgerRow({ Box, Text }: Els, r: Row) {
  const sub = (r.sub ?? []).filter(Boolean)
  const routeColor = r.route === undefined ? undefined : colorOf(r.route)
  return (
    <Box key={r.key} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          <Text color={r.color ?? routeColor}>●</Text>
        </Box>
        {/* minWidth 0 on every shrinking text Box: the desktop lays Boxes out as CSS flex, where a Box never shrinks below its text without it, so the text pushes the cost off the row. */}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={routeColor} wrap="truncate-end">{r.name}</Text>
        </Box>
        <Box width={8} flexShrink={0} justifyContent="flex-end">
          <Text bold>{money(r.usd)}</Text>
        </Box>
        {r.share === undefined ? null : (
          <Box width={5} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{`${Math.round(r.share * 100)}%`}</Text>
          </Box>
        )}
      </Box>
      {sub.length > 0 ? <Text dimColor>{`   ${sub.join('\n   ')}`}</Text> : null}
    </Box>
  )
}

/** Each row's share of `total`, or 0 when nothing was spent. */
export const shareOf = (usd: number, total: number) => (total > 0 ? usd / total : 0)

/** A pane's TIPS section, boxed apart from the figures above it, or nothing when there are none. */
export function tipsSection({ Box, Text }: Els, tips: readonly Tip[]) {
  if (tips.length === 0) return null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" borderDimColor paddingX={1}>
      <Text bold color="warning">TIPS</Text>
      {tips.map(one => (
        <Box key={`t:${one.key}`} flexDirection="row" gap={1}>
          <Box width={2} flexShrink={0}>
            <Text color="warning">›</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text>{one.text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}
