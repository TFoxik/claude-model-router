import type { Scope } from '../../types'
import type { HandoffRow, HandoffStatus } from '../handoffs'
import { STAMP_W, stamp } from './kit'
import type { Els } from './kit'

type HandoffsData = { open: readonly HandoffRow[]; closed: readonly HandoffRow[]; isClosedShown: boolean; scope: Scope; repo: string; folder: string }
type HandoffsActions = {
  resume: (path: string) => void
  setStatus: (path: string, status: HandoffStatus) => void
  reopen: (path: string) => void
  toggleClosed: () => void
  setScope: (scope: Scope) => void
}

/**
 * A stamped title with its buttons on the line below.
 *
 * The title stays out of every Button: a desktop draws a Button as a native one-line control.
 */
function row({ Box, Text, Button }: Els, one: HandoffRow, showsRepo: boolean, isClosed: boolean, act: HandoffsActions) {
  return (
    <Box key={`h:${one.path}`} flexDirection="row">
      <Box width={STAMP_W} flexShrink={0}>
        <Text dimColor>{stamp(one.at)}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text dimColor={isClosed} wrap="wrap">
          {showsRepo ? <Text dimColor>{`${one.repo} · `}</Text> : null}
          {one.title}
        </Text>
        <Box flexDirection="row" gap={2}>
          {isClosed ? <Text dimColor italic>{one.reason}</Text> : null}
          <Button key={`resume:${one.path}`} label="Resume" plain onPress={() => act.resume(one.path)} />
          {!one.isOpen ? (
            <Button key={`reopen:${one.path}`} label="Reopen" plain dimColor onPress={() => act.reopen(one.path)} />
          ) : (
            <>
              <Button key={`done:${one.path}`} label="Done" plain dimColor onPress={() => act.setStatus(one.path, 'done')} />
              <Button key={`drop:${one.path}`} label="Not relevant" plain dimColor onPress={() => act.setStatus(one.path, 'dropped')} />
            </>
          )}
        </Box>
      </Box>
    </Box>
  )
}

export function handoffsPaneView(els: Els, { open, closed, isClosedShown, scope, repo, folder }: HandoffsData, act: HandoffsActions) {
  const { Box, Text, Button } = els
  const showsRepo = scope === 'all'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Handoffs · {scope === 'repo' ? repo : 'all repos'}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="scope-repo" label="This repo" plain dimColor={scope !== 'repo'} onPress={() => act.setScope('repo')} />
          <Button key="scope-all" label="All" plain dimColor={scope !== 'all'} onPress={() => act.setScope('all')} />
        </Box>
      </Box>
      {open.length === 0 && closed.length === 0 ? (
        <Text dimColor wrap="wrap">{`No handoffs in ${scope === 'repo' ? repo : 'any repo'}. Auto-handoff saves them here when it's on; so does /handoff.`}</Text>
      ) : null}
      {open.map(one => row(els, one, showsRepo, false, act))}
      {closed.length === 0 ? null : (
        <Box flexDirection="column" gap={1}>
          <Button key="closed-toggle" label={isClosedShown ? 'hide closed' : `show ${closed.length} closed`} plain dimColor onPress={act.toggleClosed} />
          {isClosedShown ? closed.map(one => row(els, one, showsRepo, true, act)) : null}
        </Box>
      )}
      <Text dimColor wrap="wrap">{folder}</Text>
    </Box>
  )
}
