import type { EngineInterface, RenderChildren } from 'claude-code'

import type { CostTab, Rewrite, RouteSpend } from '../../types'
import { kTokens, money } from '../routes'
import type { Tip, TipAction } from '../tips'

export const PANES = {
  route: { id: 'model-router', title: 'Routes' },
  cost: { id: 'model-router-cost', title: 'Cost' },
  context: { id: 'model-router-ctx', title: 'Context' },
  learn: { id: 'model-router-learn', title: 'Learn' },
  handoffs: { id: 'model-router-handoffs', title: 'Handoffs' },
} as const

/** Ids of panes merged into Cost: one left open across an update still renders. */
export const OLD_COST_IDS = ['model-router-last', 'model-router-stats'] as const

export const COST_TABS: readonly CostTab[] = ['last', 'session', 'history']
export const COST_TAB_LABEL: Record<CostTab, string> = { last: 'Last prompt', session: 'Session', history: 'History' }

type Opened = { pane: keyof typeof PANES; tab?: CostTab }

/** What `/route <name>` and the views can open: a pane, or the Cost pane on a tab. `stats` is the History tab's older name. */
const TARGETS = {
  route: { pane: 'route' },
  cost: { pane: 'cost' },
  context: { pane: 'context' },
  learn: { pane: 'learn' },
  handoffs: { pane: 'handoffs' },
  last: { pane: 'cost', tab: 'last' },
  session: { pane: 'cost', tab: 'session' },
  history: { pane: 'cost', tab: 'history' },
  stats: { pane: 'cost', tab: 'history' },
} satisfies Record<keyof typeof PANES, Opened> & Record<string, Opened>

export type Target = keyof typeof TARGETS

export const isTarget = (name: string): name is Target => Object.hasOwn(TARGETS, name)

export const paneOf = (target: Target): Opened => TARGETS[target]

/** Opens a pane, or the Cost pane on a tab; the view gets it from the hooks module, which holds `$`. */
export type Open = (target: Target) => void

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

type Bullets = {
  title: string
  color: string
  items: ReadonlyArray<{ key: string; body: RenderChildren }>
  /** Dim lines above and below the bullets. */
  lead?: string
  tail?: readonly string[]
}

/** A section boxed apart from the figures above it: a coloured title, then `›` bullets. */
export function bulletSection({ Box, Text }: Els, { title, color, items, lead, tail = [] }: Bullets) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor paddingX={1}>
      <Text bold color={color}>{title}</Text>
      {lead === undefined ? null : <Text dimColor wrap="wrap">{lead}</Text>}
      {items.map(one => (
        <Box key={`t:${one.key}`} flexDirection="row" gap={1}>
          <Box width={2} flexShrink={0}>
            <Text color={color}>›</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {one.body}
          </Box>
        </Box>
      ))}
      {tail.map((one, i) => (
        <Text key={`tail:${i}`} dimColor wrap="wrap">{one}</Text>
      ))}
    </Box>
  )
}

/**
 * A pane's TIPS section, or nothing when there are none. A tip with an action
 * gets a button under its text that hands the action on.
 * `title`, `color` and `tail` let another list of tips, such as the unused
 * items, take the same shape.
 */
export function tipsSection(
  els: Els,
  tips: readonly Tip[],
  onAction?: (action: TipAction) => void,
  { title = 'TIPS', color = 'warning', lead, tail }: { title?: string; color?: string; lead?: string; tail?: readonly string[] } = {},
) {
  const { Box, Text, Button } = els
  if (tips.length === 0) return null
  const body = (one: Tip) => {
    const text =
      one.title === undefined
        ? [<Text key="text">{one.text}</Text>]
        : [<Text key="title" bold>{one.title}</Text>, <Text key="text" dimColor wrap="wrap">{one.text}</Text>]
    if (one.action === undefined || onAction === undefined) return text
    const action = one.action
    return [...text, <Box key="action" flexDirection="row"><Button key={`action:${one.key}`} label={action.label} onPress={() => onAction(action)} /></Box>]
  }
  return bulletSection(els, { title, color, items: tips.map(one => ({ key: one.key, body: body(one) })), ...(lead === undefined ? {} : { lead }), ...(tail ? { tail } : {}) })
}
