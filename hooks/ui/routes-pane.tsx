
import type { RenderChildren } from 'claude-code'

import type { ActiveRoute, ColdGuard, PromptCost, RouteSetting, RouterConfig } from '../../types'
import {
  CACHE_TTLS,
  EFFORTS,
  GUARDS,
  MODELS,
  PRESETS,
  ROUTES,
  SUB_CONTEXT,
  draftSummary,
  isLoopRoute,
  kTokens,
  money,
  plural,
  presetOf,
  routeLabel,
  routeText,
  shortLabel,
  subagentCount,
  withPreset,
  withRoute,
} from '../routes'
import { colorOf } from './kit'
import type { Els } from './kit'

const MODEL_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  ...Object.entries(MODELS).map(([value, m]) => ({ value, label: shortLabel(m.label) })),
]

const MODEL_W = 11
const EFFORT_W = 10

const effortOptions = (canAuto: boolean) => [
  { value: 'inherit', label: 'inherit' },
  ...(canAuto ? [{ value: 'auto', label: 'auto' }] : []),
  ...EFFORTS.map(value => ({ value, label: value })),
]

const GROUPS = [
  { title: 'Main loop', rows: ROUTES.filter(one => isLoopRoute(one.key)) },
  { title: 'Subagents', rows: ROUTES.filter(one => !isLoopRoute(one.key)) },
]

const INHERIT: RouteSetting = { model: 'inherit', effort: 'inherit' }

const signed = (usd: number) => `${usd >= 0 ? '+' : '−'}${money(Math.abs(usd))}`

type PaneData = {
  cfg: RouterConfig
  /** This session's spend, every route. */
  total: number
  now: ActiveRoute | null
  isPlanning: boolean
  pending: RouterConfig | null
  lastPrompt: PromptCost | null
  contextTokens: number
  sessionModel: string
  isBand: boolean
}

type PaneActions = {
  /** Sets the next draft from the current one (or the config); a draft equal to the config is dropped. */
  editDraft: (fn: (c: RouterConfig) => RouterConfig) => void
  toggle: () => void
  setLearning: (isOn: boolean) => void
  setHandoffs: (isOn: boolean) => void
  setAutoHandoff: (isOn: boolean) => void
  setBand: (isShown: boolean) => void
  openHandoffs: () => void
  setShowNext: (isOn: boolean) => void
  openLearn: () => void
  setGuard: (mode: ColdGuard) => void
  setTtl: (minutes: number) => void
  setKeepText: (keep: boolean) => void
  apply: (next: RouterConfig) => void
  discard: () => void
}

const GUARD_OPTIONS = GUARDS.map(value => ({ value, label: value }))
const TTL_OPTIONS = CACHE_TTLS.map(minutes => ({ value: String(minutes), label: `${minutes} min` }))
const SELECT_W = 12

type Setting = {
  key: string
  name: string
  /** On/off settings show their state after the name. */
  state?: { isOn: boolean; on?: string; off?: string }
  note?: string
  controls: RenderChildren
  isChild?: boolean
}

/** A setting: its name and state, a dim line saying what it does, and its controls on the right. */
function settingRow({ Box, Text }: InputEls, { key, name, state, note, controls, isChild }: Setting) {
  return (
    <Box key={key} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} paddingLeft={isChild ? 2 : 0}>
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text>
          {name}
          {state ? <Text color={state.isOn ? 'success' : 'subtle'}>{state.isOn ? ` ● ${state.on ?? 'on'}` : ` ○ ${state.off ?? 'off'}`}</Text> : null}
        </Text>
        {note ? <Text dimColor>{note}</Text> : null}
      </Box>
      <Box flexDirection="row" gap={1} flexShrink={0}>
        {controls}
      </Box>
    </Box>
  )
}

/** Every setting in one place, below the routing it serves; each applies at once, not through the draft. */
function settingsSection(els: InputEls, { cfg, isBand }: PaneData, a: PaneActions) {
  const { Box, Text, Button, Select } = els
  const group = (title: string) => <Text key={`sg:${title}`} bold color="claude">{title}</Text>
  const turn = (key: string, isOn: boolean, set: (isOn: boolean) => void) => <Button key={key} label={isOn ? 'Turn off' : 'Turn on'} onPress={() => set(!isOn)} />
  /** An on/off setting whose note says what turning it on would do. */
  const toggle = (key: string, name: string, isOn: boolean, set: (isOn: boolean) => void, offNote: string, extra?: RenderChildren, isChild?: boolean) =>
    settingRow(els, { key: `set-${key}`, name, state: { isOn }, note: isOn ? undefined : offNote, controls: [turn(`${key}-toggle`, isOn, set), extra], isChild })
  const select = (key: string, options: Array<{ value: string; label: string }>, value: string, onSelect: (value: string) => void) => (
    <Box width={SELECT_W}>
      <Select key={key} options={options} value={value} onSelect={onSelect} />
    </Box>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
      <Text bold dimColor>SETTINGS</Text>
      <Box flexDirection="column" gap={1}>
        {group('Coaching')}
        {toggle('learn', 'Learn mode', cfg.isLearning, a.setLearning, 'explains cache misses and model costs with your own numbers, when they happen', <Button key="learn-open" label="Open" onPress={a.openLearn} />)}
        {toggle('next', 'Next-step advice', cfg.showNext, a.setShowNext, 'shows next /clear, /compact or /handoff in the band when carrying on is not the best move')}
      </Box>
      <Box flexDirection="column" gap={1}>
        {group('Handoffs')}
        {toggle('handoffs', 'Handoffs', cfg.isHandoffs, a.setHandoffs, 'counts open handoffs in the band and lets auto-handoff run', <Button key="handoffs-open" label="Open" onPress={a.openHandoffs} />)}
        {cfg.isHandoffs ? toggle('handoff', 'Auto-handoff', cfg.autoHandoff, a.setAutoHandoff, 'saves a handoff while the cache is warm, before it goes cold with work open', undefined, true) : null}
      </Box>
      <Box flexDirection="column" gap={1}>
        {group('Cache and display')}
        {settingRow(els, {
          key: 'set-guard',
          name: 'Cold-cache guard',
          note: 'a send onto a cold cache: held once with its price, sent with it, or not checked',
          controls: select('guard', GUARD_OPTIONS, cfg.coldGuard, value => a.setGuard(value as ColdGuard)),
        })}
        {settingRow(els, {
          key: 'set-ttl',
          name: 'Cache lifetime',
          note: 'the prompt-cache TTL the warm/cold timer counts down',
          controls: select('ttl', TTL_OPTIONS, String(cfg.cacheTtlMinutes), value => a.setTtl(Number(value))),
        })}
        {settingRow(els, {
          key: 'set-text',
          name: 'Keep prompt text',
          state: { isOn: cfg.keepPromptText },
          note: cfg.keepPromptText ? 'the first 120 characters of each prompt, for Cost › History; off also removes text already kept' : 'Cost › History keeps only labels and costs',
          controls: turn('text-toggle', cfg.keepPromptText, a.setKeepText),
        })}
        {settingRow(els, {
          key: 'set-band',
          name: 'Band',
          state: { isOn: isBand, on: 'shown', off: 'hidden' },
          note: 'the route, cache and cost lines above the prompt; routing works either way',
          controls: <Button key="band-toggle" label={isBand ? 'Hide' : 'Show'} onPress={() => a.setBand(!isBand)} />,
        })}
      </Box>
    </Box>
  )
}

export function routesMobileView({ Box, Text }: Els, now: ActiveRoute | null) {
  return (
    <Box flexDirection="column">
      <Text color={now ? colorOf(now.route) : undefined} bold>
        {now ? `▸ ${now.route} · ${routeText(now.model, now.effort)}` : '▸ waiting'}
      </Text>
      <Text dimColor>Edit routes with /route set, or from a terminal or desktop.</Text>
    </Box>
  )
}

/** The element set of a surface that takes input; a phone gets routesMobileView instead. */
type InputEls = Extract<Els, { Select: unknown }>

export function routesPaneView(els: InputEls, data: PaneData, actions: PaneActions) {
  const { cfg, total, now, isPlanning, pending, lastPrompt, contextTokens, sessionModel } = data
  const { editDraft, toggle, apply, discard } = actions
  const { Box, Text, Button, Select } = els
  const shown = pending ?? cfg
  const ttlMinutes = cfg.cacheTtlMinutes
  const liveRoute = isPlanning ? 'plan' : 'main'
  const { changes, upFront, toggleNow, toggleAfter, payback } = draftSummary(cfg, pending, { contextTokens, liveRoute, sessionModel, ttlMinutes })
  const changed = new Set(changes.map(one => one.route))
  const setRoute = (route: string, patch: Partial<RouteSetting>) => editDraft(c => withRoute(c, route, { ...(c.routes[route] ?? INHERIT), ...patch }))

  const presetOptions = [
    ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
    ...(presetOf(shown.preset) ? [] : [{ value: shown.preset, label: 'Custom' }]),
  ]

  const subs = lastPrompt ? subagentCount(lastPrompt) : 0
  const nowColor = now ? colorOf(now.route) : 'subtle'

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="claude">⚙ Routes</Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={cfg.isEnabled ? 'success' : 'subtle'}>{cfg.isEnabled ? '● on' : '○ off'}</Text>
          <Button key="toggle" label={cfg.isEnabled ? 'Turn off' : 'Turn on'} onPress={toggle} />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={nowColor} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={nowColor}>
            {now ? `▸ ${now.route}  ${routeText(now.model, now.effort ?? 'default')}` : '▸ waiting for the first request'}
          </Text>
          <Text dimColor>{money(total)}</Text>
        </Box>
        <Text dimColor>
          plan mode {isPlanning ? 'on' : 'off'} · context {kTokens(contextTokens)} tokens
          {toggleNow > 0 ? ` · plan toggle ≈ ${money(toggleNow)}` : ' · plan toggle keeps cache'}
        </Text>
        {lastPrompt ? (
          <Text dimColor>
            last prompt {money(lastPrompt.usd)} · {plural(lastPrompt.requests, 'request')}
            {subs > 0 ? ` · ${plural(subs, 'subagent')}` : ''}
          </Text>
        ) : null}
        {now?.isHeld ? <Text color="warning">auto kept the current effort to protect the cache</Text> : null}
      </Box>

      <Box flexDirection="row" gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold dimColor>PRESET</Text>
        </Box>
        <Box width={MODEL_W + EFFORT_W + 1} flexShrink={0}>
          <Select
            key="preset"
            options={presetOptions}
            value={shown.preset}
            onSelect={value => editDraft(c => withPreset(c, value) ?? c)}
          />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {GROUPS.map(group => (
          <Box key={`g:${group.title}`} flexDirection="column" marginBottom={1}>
            <Text bold dimColor>{group.title.toUpperCase()}</Text>
            {group.rows.map(row => {
              const key = row.key
              const setting = shown.routes[key] ?? INHERIT
              const isChild = row.parent === 'sub:*'
              const isLive = now?.route === key
              return (
                <Box key={`row:${key}`} flexDirection="row" gap={1}>
                  <Text color={changed.has(key) ? 'warning' : isLive ? colorOf(key) : 'subtle'}>
                    {changed.has(key) ? '●' : isLive ? '▸' : ' '}
                  </Text>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <Text color={isChild ? undefined : colorOf(key)} bold={!isChild} wrap="truncate-end">
                      {isChild ? `└ ${row.label}` : row.label}
                    </Text>
                  </Box>
                  <Box width={MODEL_W} flexShrink={0}>
                    <Select
                      key={`m:${key}`}
                      options={MODEL_OPTIONS}
                      value={setting.model}
                      onSelect={value => setRoute(key, { model: value as RouteSetting['model'] })}
                    />
                  </Box>
                  <Box width={EFFORT_W} flexShrink={0}>
                    <Select
                      key={`e:${key}`}
                      options={effortOptions(isLoopRoute(key))}
                      value={setting.effort}
                      onSelect={value => setRoute(key, { effort: value as RouteSetting['effort'] })}
                    />
                  </Box>
                </Box>
              )
            })}
          </Box>
        ))}
        <Text dimColor>inherit → falls back to the row above, then the session · forks always use the parent's model</Text>
      </Box>

      {pending === null ? (
        <Text dimColor>Changes above are a draft until you press Apply.</Text>
      ) : (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">
            ● Draft — {plural(changes.length, 'change')}, not applied
          </Text>
          {changes.map(one => (
            <Box key={`c:${one.route}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text color={colorOf(one.route)}>{routeLabel(one.route)}</Text>
                <Text color={one.perTurnDelta <= 0 ? 'success' : 'error'}>
                  {signed(one.perTurnDelta)}/{isLoopRoute(one.route) ? 'turn' : 'run'}
                </Text>
              </Box>
              <Text>
                <Text dimColor>{one.from}</Text> → {one.to}
              </Text>
              {one.switchCost > 0 ? <Text color="warning">cache {money(one.switchCost)} now</Text> : null}
            </Box>
          ))}
          <Box flexDirection="column">
            <Text>
              up-front <Text bold color={upFront > 0 ? 'warning' : 'success'}>{money(upFront)}</Text>
            </Text>
            <Text>
              plan toggle {money(toggleNow)} → <Text bold>{money(toggleAfter)}</Text>
            </Text>
            {payback !== undefined ? <Text color="success">pays back in ~{payback} turns</Text> : null}
          </Box>
          <Text dimColor>rough: medium-length turns, {kTokens(SUB_CONTEXT)}-token subagent context</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="apply" label="Apply" variant="primary" onPress={() => apply(pending)} />
            <Button key="discard" label="Discard" onPress={discard} />
          </Box>
        </Box>
      )}

      {settingsSection(els, data, actions)}
    </Box>
  )
}
