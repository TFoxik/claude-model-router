import { atom, read, update } from 'claude-code'
import type { Args, EngineInterface, On } from 'claude-code'

import type { CostTab } from '../../types'
import { todayUsd } from '../core/ledger'
import { allRecords } from '../core/measure'
import { closePanes, raisePane } from '../core/panes'
import { session } from '../core/session'
import { STORE, configOf, promptCostOf, save, spendOf } from '../core/state'
import { OLD_COST_IDS, PANES } from '../ui/kit'
import { costPaneView } from './cost-pane'
import { statsFooterView } from './stats'

type $ = EngineInterface

// The engine's scan accepts an atom only in the file that declares it, so other files go through the functions below.
const statsScope = atom({ plugin: 'model-router', key: 'statsScope' } as const, 'repo' as 'repo' | 'all')
const costTab = atom({ plugin: 'model-router', key: 'costTab' } as const, 'last' as CostTab)

async function openHistory($: $) {
  await update($, costTab, () => 'history')
  await raisePane($, 'cost').catch(() => undefined)
}

async function renderStatsFooter($: $, e: Args<'ui.render'>, modes: readonly string[]) {
  const { records, now } = await allRecords($)
  return statsFooterView($.ui.resolve(e), { modes, today: todayUsd(records, now) }, { open: () => void openHistory($) })
}

async function renderCostPane($: $, e: Args<'ui.render'>) {
  const [tab, scope, lastPrompt, costs, cfg] = await Promise.all([read($, costTab), read($, statsScope), promptCostOf($), spendOf($), configOf($)])
  const { records: all, now } = tab === 'history' ? await allRecords($) : { records: [], now: 0 }
  const records = scope === 'repo' ? all.filter(r => r.repo === session.repo) : all
  return costPaneView($.ui.resolve(e), { tab, lastPrompt, costs, records, scope, repo: session.repo, now, ttlMinutes: cfg.cacheTtlMinutes }, {
    setTab: next => void update($, costTab, () => next),
    setScope: async next => void save($, STORE.statsScope, await update($, statsScope, () => next)),
  })
}

export function registerCost(on: On): void {
  for (const id of [PANES.cost.id, ...OLD_COST_IDS]) {
    on('ui.render', { component: 'Pane', requestId: id }, async ($, e, next) => ((await configOf($)).isCost ? renderCostPane($, e) : next(e)))
  }
}

export function registerCostFooter(on: On): void {
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode' || !(await configOf($)).isCost) return next(e)
    return renderStatsFooter($, e, e.props.modes)
  })
}

export async function closeCostPanes($: $): Promise<void> {
  await closePanes($, [PANES.cost.id, ...OLD_COST_IDS])
}

export async function costOnSessionStart($: $, scope: unknown): Promise<void> {
  if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
}

export async function setCostTab($: $, tab: CostTab): Promise<void> {
  await update($, costTab, () => tab)
}
