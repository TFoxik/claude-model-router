import type { Health } from '../../types'
import { money } from '../core/format'
import type { BandPart } from '../ui/band'

const level = (value: number, warn: number, bad: number) => (value >= bad ? 'error' : value >= warn ? 'warning' : undefined)

export function costBandPart(health: Health | null, total: number): BandPart {
  return {
    segment: ({ Text }) => {
      if (health === null) return null
      const limits = [['5h', health.fiveHour], ['7d', health.sevenDay]].filter((one): one is [string, number] => one[1] !== undefined)
      return (
        <Text key="h-cost">
          {`last ${money(health.last)} · session ${money(total)}`}
          {limits.map(([name, pct]) => (
            <Text key={`l:${name}`}>
              {` · ${name} `}
              <Text color={level(pct, 70, 90)}>{pct}%</Text>
            </Text>
          ))}
        </Text>
      )
    },
    buttons: [{ key: 'band-cost', label: 'Cost', target: 'last', look: 'dim' }],
  }
}
