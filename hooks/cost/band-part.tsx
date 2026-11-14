import type { Health, Levels } from '../../types'
import { levelOf } from '../core/config'
import { money } from '../core/format'
import type { BandPart } from '../ui/band'

export function costBandPart(health: Health | null, total: number, levels: Levels): BandPart {
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
              <Text color={levelOf('limits', pct, levels)}>{pct}%</Text>
            </Text>
          ))}
        </Text>
      )
    },
    buttons: [{ key: 'band-cost', label: 'Cost', target: 'last', look: 'dim' }],
  }
}
