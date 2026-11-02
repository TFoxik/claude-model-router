import type { Health, WarmRun } from '../../types'
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

/** A keep-warm run: the time it may still ping and what its pings cost so far, on screen whether or not Cost is on. */
export function warmBandPart(run: WarmRun, now: number, stop: () => void): BandPart {
  const left = Math.max(0, Math.ceil((run.until - now) / 60_000))
  return {
    segment: ({ Text }) => (
      <Text key="h-warm">
        <Text color="success">warm ●</Text>
        {` ${Math.floor(left / 60)}h ${left % 60}m left · ${money(run.usd)}`}
      </Text>
    ),
    buttons: [{ key: 'warm-stop', label: 'Stop warm', press: stop, look: 'plain' }],
  }
}
