import type { Health } from '../../types'
import { money } from '../core/format'
import type { BandPart } from '../ui/band'

export function contextBandPart(health: Health | null): BandPart {
  const advice = health?.advice
  return {
    segment: ({ Text }) =>
      health === null ? null : (
        <Text key="h-context">
          {'cache '}
          {health.warmMinutes === 0 ? (
            <Text color="error">{health.coldUsd === undefined ? 'cold' : `cold ${money(health.coldUsd)}`}</Text>
          ) : (
            <Text>
              <Text color={health.cache < 50 ? 'error' : health.cache < 80 ? 'warning' : 'success'}>{health.cache}%</Text>{' '}
              <Text color={health.warmMinutes <= 5 ? 'warning' : undefined}>{health.warmMinutes}m</Text>
            </Text>
          )}
          {' · context '}
          <Text color={health.ctxLevel}>{health.ctx}%</Text>
        </Text>
      ),
    buttons: [
      ...(advice === undefined ? [] : [{ key: 'advice', label: `next ${advice.command}`, target: 'context' as const, look: 'primary' as const }]),
      { key: 'ctx', label: 'Context', target: 'context', look: 'dim' },
    ],
  }
}
