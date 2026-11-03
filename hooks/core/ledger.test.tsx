import { expect, test } from 'claude-code/testing'

import type { PromptRecord } from '../../types'
import { compactRecord, sanitizeHistory } from './ledger'

const record: PromptRecord = {
  at: 1,
  repo: 'app',
  label: 'prompt',
  text: 'hi',
  usd: 0.46830459999999996,
  requests: 9,
  agents: 0,
  models: { 'Opus 5.5 high': 0.46830460000000007, 'Haiku 5.5': 0.0000004 },
  rewrites: [{ cause: 'cold', tokens: 120_000, usd: 1.2345678912 }],
}

test('saved prompts keep their costs to the micro-dollar', () => {
  expect(compactRecord(record)).toEqual({
    ...record,
    usd: 0.468305,
    models: { 'Opus 5.5 high': 0.468305, 'Haiku 5.5': 0 },
    rewrites: [{ cause: 'cold', tokens: 120_000, usd: 1.234568 }],
  })
  const plain = { ...record, models: undefined, rewrites: undefined }
  expect(compactRecord(plain)).toEqual({ ...plain, usd: 0.468305 })
})

test('history read back from the store comes back compacted', () => {
  expect(sanitizeHistory([record])).toEqual([compactRecord(record)])
})
