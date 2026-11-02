import type { EngineInterface } from 'claude-code'

import { PANES } from '../ui/kit'

/** Opening an open pane only retitles it, so one open behind another is reopened to come to the front. */
export async function raisePane($: EngineInterface, pane: keyof typeof PANES): Promise<void> {
  const open = (await $.ui.panes().catch(() => [])).find(one => one.id === PANES[pane].id)
  if (open !== undefined && !open.isShown) await $.ui.close({ id: PANES[pane].id })
  await $.ui.open(PANES[pane])
}

/** Closes whichever of these panes is open. */
export async function closePanes($: EngineInterface, ids: readonly string[]): Promise<void> {
  const open = await $.ui.panes().catch(() => [])
  for (const one of open) if (ids.includes(one.id)) await $.ui.close({ id: one.id }).catch(() => undefined)
}
