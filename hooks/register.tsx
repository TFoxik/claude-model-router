import { atom, read, update } from 'claude-code'
import type { Args, BoxProps, ElementConstructor, EngineInterface, Register } from 'claude-code'

import type { ActiveRoute, Effort, Health, LastUsage, PromptCost, PromptItem, PromptRecord, RouteSetting, RouteSpend, RouterConfig } from '../types'
import {
  AUTO_LABELS,
  DEFAULT_CONFIG,
  DEFAULT_TTL,
  EFFORTS,
  EMPTY_SPEND,
  FORK,
  MODELS,
  PRESETS,
  PRICES_AS_OF,
  ROUTES,
  SUB_CONTEXT,
  addSpend,
  HISTORY_LIMIT,
  commandLabel,
  commandStats,
  modelMix,
  sameDay,
  contextLevel,
  costOf,
  estimateChanges,
  modeSwitchCost,
  effortForLabel,
  labelOf,
  money,
  parseSetting,
  resolve,
  routeForSpawn,
  shouldSwitch,
} from './routes'

const PANE = 'model-router'
const LAST_PANE = 'model-router-last'
const CTX_PANE = 'model-router-ctx'
const STATS_PANE = 'model-router-stats'
const STORE_KEY = 'config'

const config = atom({ plugin: 'model-router', key: 'config' } as const, DEFAULT_CONFIG)
const spend = atom({ plugin: 'model-router', key: 'spend' } as const, {} as Record<string, RouteSpend>)
const isPlan = atom({ plugin: 'model-router', key: 'isPlan' } as const, false)
const agents = atom({ plugin: 'model-router', key: 'agents' } as const, {} as Record<string, string>)
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as ActiveRoute | null)
const draft = atom({ plugin: 'model-router', key: 'draft' } as const, null as RouterConfig | null)
const lastUsage = atom({ plugin: 'model-router', key: 'lastUsage' } as const, null as LastUsage | null)
const health = atom({ plugin: 'model-router', key: 'health' } as const, null as Health | null)
const agentLabels = atom({ plugin: 'model-router', key: 'agentLabels' } as const, {} as Record<string, string>)
const history = atom({ plugin: 'model-router', key: 'history' } as const, [] as PromptRecord[])
const statsScope = atom({ plugin: 'model-router', key: 'statsScope' } as const, 'repo' as 'repo' | 'all')
const promptCost = atom({ plugin: 'model-router', key: 'promptCost' } as const, null as PromptCost | null)
const isBandShown = atom({ plugin: 'model-router', key: 'isBandShown' } as const, true)

type $ = EngineInterface

export async function setConfig(
  $: $,
  fn: (c: RouterConfig) => RouterConfig,
): Promise<RouterConfig> {
  const next = await update($, config, fn)
  await $.store.set(STORE_KEY, next)
  await refreshStatus($)
  return next
}

const shortRoute = (cfg: RouterConfig, route: string) => {
  const r = resolve(cfg, route)
  const model = r.model ? labelOf(r.model).replace(/ [\d.]+$/, '') : 'inherit'
  return `${model}${r.effort ? ` ${r.effort}` : ''}`
}

async function refreshStatus($: $) {
  const last = await read($, lastUsage)
  if (last === null) return
  const { context, rateLimits } = await $.session.usage()
  const tokens = context.tokens ?? last.input + last.cacheRead + last.cacheWrite
  const prompt = last.input + last.cacheRead + last.cacheWrite
  const five = rateLimits.find(one => one.kind === 'five_hour')
  const seven = rateLimits.find(one => one.kind === 'seven_day')
  const now = await $.clock.now().catch(() => Date.now())
  const ttl = (await read($, config)).cacheTtlMinutes ?? 60
  const warmMinutes = Math.max(0, Math.ceil((last.at + ttl * 60_000 - now) / 60_000))
  const resetMs = five?.resetsAt ? Date.parse(five.resetsAt) - now : undefined
  if (mem.compactCheckedAt === undefined || now - mem.compactCheckedAt > 10 * 60_000) {
    const { context: detailed } = await $.session.usage({ breakdown: 'summary' })
    const b = detailed.breakdown
    mem.compactAt = b?.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    mem.compactCheckedAt = now
  }
  const next: Health = {
    cache: prompt > 0 ? Math.round((last.cacheRead / prompt) * 100) : 0,
    warmMinutes,
    ctx: context.percent ?? Math.round((tokens / context.window) * 100),
    ctxLevel: contextLevel(tokens, context.window, mem.compactAt),
    last: (await read($, promptCost))?.usd ?? last.usd,
    toggle: modeSwitchCost(await read($, config), tokens, last.model),
    ...(five ? { fiveHour: Math.round(five.percentUsed) } : {}),
    ...(resetMs !== undefined && resetMs > 0 ? { resetMinutes: Math.round(resetMs / 60_000) } : {}),
    ...(seven ? { sevenDay: Math.round(seven.percentUsed) } : {}),
  }
  await update($, health, () => next)
}

const level = (value: number, warn: number, bad: number) => (value >= bad ? 'error' : value >= warn ? 'warning' : undefined)

function modelsOf(p: PromptCost): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of p.items) {
    const key = `${labelOf(item.model)}${item.effort ? ` ${item.effort}` : ''}`
    out[key] = (out[key] ?? 0) + item.usd
  }
  return out
}

async function recordPrompt($: $) {
  const p = await read($, promptCost)
  const meta = mem.current
  mem.current = undefined
  if (p === null || meta === undefined || p.usd <= 0) return
  const rec: PromptRecord = {
    at: meta.at,
    repo: mem.repo,
    label: meta.label,
    text: meta.text,
    usd: p.usd,
    requests: p.requests,
    agents: p.items.filter(one => one.id !== one.route).length,
    models: modelsOf(p),
  }
  const next = await update($, history, all => [...all, rec].slice(-HISTORY_LIMIT))
  await $.store.set('history', next)
}

async function renderStatsFooter($: $, e: Args<'ui.render'>, modes: readonly string[]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const all = await read($, history)
  const live = await read($, promptCost)
  const now = await $.clock.now().catch(() => Date.now())
  const today = all.filter(r => sameDay(r.at, now)).reduce((sum, r) => sum + r.usd, 0) + (live?.usd ?? 0)
  return (
    <Box flexDirection="row" flexShrink={0}>
      {modes.length > 0 ? <Text dimColor>{`${modes.join(' & ')}  `}</Text> : null}
      <Button
        key="stats"
        label={`▤ today ${money(today)}`}
        plain
        dimColor
        onPress={() => $.ui.open({ id: STATS_PANE, title: 'Stats' })}
      />
    </Box>
  )
}

async function renderStatsPane($: $, e: Args<'ui.render'>) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const scope = await read($, statsScope)
  const saved = await read($, history)
  const live = await read($, promptCost)
  const current = mem.current
  const all: PromptRecord[] =
    live && current && live.usd > 0
      ? [...saved, { at: current.at, repo: mem.repo, label: current.label, text: current.text, usd: live.usd, requests: live.requests, agents: live.items.filter(one => one.id !== one.route).length, models: modelsOf(live) }]
      : saved
  const records = scope === 'repo' ? all.filter(r => r.repo === mem.repo) : all
  const now = await $.clock.now().catch(() => Date.now())
  const sum = (rs: readonly PromptRecord[]) => rs.reduce((acc, r) => acc + r.usd, 0)
  const today = sum(records.filter(r => sameDay(r.at, now)))
  const week = sum(records.filter(r => now - r.at < 7 * 86_400_000))
  const commands = commandStats(records).slice(0, 10)
  const priciest = [...records].sort((x, y) => y.usd - x.usd).slice(0, 8)
  const setScope = async (next: 'repo' | 'all') => {
    await update($, statsScope, () => next)
    await $.store.set('statsScope', next)
  }
  const day = (at: number) => {
    const d = new Date(at)
    return `${d.getDate()}.${d.getMonth() + 1}.`
  }
  const row = (key: string, color: string | undefined, name: string, right: string, sub?: string) => (
    <Box key={key} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          <Text color={color}>●</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-end">{name}</Text>
        </Box>
        <Box width={8} flexShrink={0} justifyContent="flex-end">
          <Text bold>{right}</Text>
        </Box>
      </Box>
      {sub ? <Text dimColor>{`   ${sub}`}</Text> : null}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Stats · {scope === 'repo' ? mem.repo : 'all repos'}</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="scope-repo" label="This repo" plain dimColor={scope !== 'repo'} onPress={() => setScope('repo')} />
          <Button key="scope-all" label="All" plain dimColor={scope !== 'all'} onPress={() => setScope('all')} />
        </Box>
      </Box>
      <Text dimColor>
        today {money(today)} · 7 days {money(week)} · all {money(sum(records))} · {records.length} prompts
      </Text>
      {records.length === 0 ? (
        <Text dimColor>Nothing recorded yet.</Text>
      ) : (
        <>
          <Box flexDirection="column">
            <Text bold dimColor>COMMANDS · AVERAGE PER RUN</Text>
            {commands.map(c =>
              row(`c:${c.label}`, c.label === 'prompt' ? 'subtle' : 'suggestion', c.label, money(c.avg), [`${c.runs} run${c.runs === 1 ? '' : 's'} · total ${money(c.total)} · max ${money(c.max)}`, modelMix(c.models, money)].filter(Boolean).join('\n   ')),
            )}
          </Box>
          <Box flexDirection="column">
            <Text bold dimColor>MOST EXPENSIVE PROMPTS</Text>
            {priciest.map((r, i) =>
              row(`p:${i}`, r.label === 'prompt' ? 'subtle' : 'suggestion', r.label === 'prompt' ? r.text : `${r.label} ${r.text.replace(r.label, '').trim()}`.trim(), money(r.usd), [`${day(r.at)} · ${scope === 'all' ? `${r.repo} · ` : ''}${r.requests} req · ${r.agents} subagent${r.agents === 1 ? '' : 's'}`, modelMix(r.models, money)].filter(Boolean).join('\n   ')),
            )}
          </Box>
        </>
      )}
      <Text dimColor>estimate · kept across sessions, last {HISTORY_LIMIT} prompts</Text>
    </Box>
  )
}

async function renderHealthRow($: $, e: Args<'ui.render'>) {
  const hp = await read($, health)
  const { Box, Text, Button } = $.ui.resolve(e)
  if (hp === null) return null
  const cacheColor = hp.cache < 50 ? 'error' : hp.cache < 80 ? 'warning' : 'success'
  return (
    <Box flexDirection="row">
      <Text dimColor>
        {'cache '}
        {hp.warmMinutes === 0 ? <Text color="error">cold</Text> : <Text color={cacheColor}>{hp.cache}%</Text>}
        {hp.warmMinutes === 0 ? null : ' '}
        {hp.warmMinutes === 0 ? null : <Text color={hp.warmMinutes <= 5 ? 'warning' : undefined}>{hp.warmMinutes}m</Text>}
        {'  ·  '}
      </Text>
      <Button key="ctx" label="context" plain dimColor onPress={() => $.ui.open({ id: CTX_PANE, title: 'Context' })} />
      <Text dimColor>
        {' '}
        <Text color={hp.ctxLevel}>{hp.ctx}%</Text>
        {'  ·  '}
      </Text>
      <Button
        key="last-cost"
        label={`last ${money(hp.last)}`}
        plain
        dimColor
        onPress={() => $.ui.open({ id: LAST_PANE, title: 'Last prompt cost' })}
      />
      {hp.fiveHour === undefined && hp.sevenDay === undefined ? null : (
        <Text dimColor>
          {hp.fiveHour === undefined ? '' : '  ·  5h '}
          {hp.fiveHour === undefined ? null : <Text color={level(hp.fiveHour, 70, 90)}>{hp.fiveHour}%</Text>}
          {hp.sevenDay === undefined ? '' : '  ·  7d '}
          {hp.sevenDay === undefined ? null : <Text color={level(hp.sevenDay, 70, 90)}>{hp.sevenDay}%</Text>}
        </Text>
      )}
    </Box>
  )
}

const MODEL_OPTIONS = [
  { value: 'inherit', label: 'inherit' },
  ...Object.entries(MODELS).map(([value, m]) => ({ value, label: m.label.replace(/ [\d.]+$/, '') })),
]

const MODEL_W = 11
const EFFORT_W = 10

const PANE_LABEL: Record<string, string> = {
  plan: 'Plan mode',
  main: 'Normal work',
  'sub:*': 'Default',
  'sub:Explore': 'Explore',
  'sub:Plan': 'Plan agent',
  'sub:general-purpose': 'General',
  workflow: 'Workflow',
  teammate: 'Teammates',
}

const effortOptions = (canAuto: boolean) => [
  { value: 'inherit', label: 'inherit' },
  ...(canAuto ? [{ value: 'auto', label: 'auto' }] : []),
  ...EFFORTS.map(value => ({ value, label: value })),
]

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const ROUTE_COLOR: Record<string, string> = { plan: 'planMode', main: 'claude' }
const colorOf = (route: string) => ROUTE_COLOR[route] ?? 'suggestion'

const GROUPS: ReadonlyArray<{ title: string; keys: readonly string[] }> = [
  { title: 'Main loop', keys: ['plan', 'main'] },
  { title: 'Subagents', keys: ['sub:*', 'sub:Explore', 'sub:Plan', 'sub:general-purpose', 'workflow', 'teammate'] },
]

const pad = (text: string, width: number) => (text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length))
// Theme keys as hex, for the one place a theme key cannot go: an SVG drawn as an image.
const HEX: Record<string, string> = {
  claude: '#d97757',
  planMode: '#5fb36b',
  suggestion: '#6ea8e0',
  success: '#5fb36b',
  warning: '#e0b24f',
  error: '#e06c6c',
  permission: '#9a8fe0',
  autoAccept: '#b48ee0',
  remember: '#6ea8e0',
  merged: '#a87fd6',
  ide: '#4fa3b8',
  bashBorder: '#e07fb0',
}
const hexOf = (key: string | undefined) => (key && key.startsWith('#') ? key : HEX[key ?? ''] ?? '#9a9893')

type Segment = { tokens: number; color?: string }

/** One horizontal bar of segments, as an SVG for surfaces that draw them. */
function stackedSvg(segments: readonly Segment[], whole: number): string {
  const w = 600
  let x = 0
  const rects = segments
    .filter(one => one.tokens > 0)
    .map(one => {
      const width = Math.max(1, (one.tokens / whole) * w)
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="14" fill="${hexOf(one.color)}"/>`
      x += width
      return rect
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 14" width="${w}" height="14"><rect width="${w}" height="14" rx="3" fill="#8b8a86" fill-opacity="0.18"/>${rects}</svg>`
}

/** The same bar as coloured block characters, for the monospace terminal. */
function stackedCells(segments: readonly Segment[], whole: number, width: number): Array<{ text: string; color?: string }> {
  const out = segments
    .filter(one => one.tokens > 0)
    .map(one => ({ text: '█'.repeat(Math.max(1, Math.round((one.tokens / whole) * width))), color: one.color }))
  const used = out.reduce((sum, one) => sum + one.text.length, 0)
  return used < width ? [...out, { text: '░'.repeat(width - used), color: undefined }] : out
}

export async function renderPane($: EngineInterface, e: Args<'ui.render'>) {
  const cfg = await read($, config)
  const costs = await read($, spend)
  const now = await read($, active)
  const isPlanning = await read($, isPlan)

  if (e.surface === 'mobile') {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color={now ? colorOf(now.route) : undefined} bold>
          {now ? `▸ ${now.route} · ${labelOf(now.model)} · ${now.effort ?? ''}` : '▸ waiting'}
        </Text>
        <Text dimColor>Edit routes with /route set, or from a terminal or desktop.</Text>
      </Box>
    )
  }
  const { Box, Text, Button, Select } = $.ui.resolve(e)

  const pending = await read($, draft)
  const lastPrompt = await read($, promptCost)
  const shown = pending ?? cfg
  const contextTokens = (await $.session.usage()).context.tokens ?? 0
  const sessionModel = now?.model ?? (await $.session.model())
  const liveRoute = isPlanning ? 'plan' : 'main'
  const ttlMinutes = cfg.cacheTtlMinutes ?? DEFAULT_TTL
  const changes = pending ? estimateChanges(cfg, pending, { contextTokens, liveRoute, sessionModel, ttlMinutes }) : []
  const changed = new Set(changes.map(one => one.route))
  const upFront = changes.reduce((sum, one) => sum + one.switchCost, 0)
  const toggleNow = modeSwitchCost(cfg, contextTokens, sessionModel)
  const toggleAfter = pending ? modeSwitchCost(pending, contextTokens, sessionModel) : toggleNow
  const livePerTurn = changes.filter(one => one.route === liveRoute).reduce((sum, one) => sum + one.perTurnDelta, 0)
  const payback = upFront > 0 && livePerTurn < 0 ? Math.ceil(upFront / -livePerTurn) : undefined

  const editDraft = async (fn: (c: RouterConfig) => RouterConfig) => {
    await update($, draft, d => {
      const next = fn(d ?? cfg)
      return JSON.stringify(next) === JSON.stringify(cfg) ? null : next
    })
    await refreshStatus($)
  }
  const setRoute = (route: string, patch: Partial<RouteSetting>) =>
    editDraft(c => {
      const was = c.routes[route] ?? { model: 'inherit', effort: 'inherit' }
      return { ...c, preset: 'custom', routes: { ...c.routes, [route]: { ...was, ...patch } } }
    })
  const signed = (usd: number) => `${usd >= 0 ? '+' : '−'}${money(Math.abs(usd))}`

  const presetOptions = [
    ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
    ...(PRESETS[shown.preset] ? [] : [{ value: shown.preset, label: 'Custom' }]),
  ]

  const spendRows = Object.entries(costs).sort((a, b) => b[1].usd - a[1].usd)
  const total = spendRows.reduce((sum, [, one]) => sum + one.usd, 0)
  const nowColor = now ? colorOf(now.route) : 'subtle'

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text bold color="claude">⚙ Model Router</Text>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={cfg.isEnabled ? 'success' : 'subtle'}>{cfg.isEnabled ? '● on' : '○ off'}</Text>
          <Button
            key="toggle"
            label={cfg.isEnabled ? 'Turn off' : 'Turn on'}
            onPress={() => setConfig($, c => ({ ...c, isEnabled: !c.isEnabled }))}
          />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={nowColor} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={nowColor}>
            {now ? `▸ ${now.route}  ${labelOf(now.model)} · ${now.effort ?? 'default'}` : '▸ waiting for the first request'}
          </Text>
          <Text dimColor>{money(total)}</Text>
        </Box>
        <Text dimColor>
          plan mode {isPlanning ? 'on' : 'off'} · context {kTokens(contextTokens)} tokens
          {toggleNow > 0 ? ` · plan toggle ≈ ${money(toggleNow)}` : ' · plan toggle keeps cache'}
        </Text>
        {lastPrompt ? (
          <Text dimColor>
            last prompt {money(lastPrompt.usd)} · {lastPrompt.requests} request{lastPrompt.requests === 1 ? '' : 's'}
            {subagentCount(lastPrompt) > 0 ? ` · ${subagentCount(lastPrompt)} subagent${subagentCount(lastPrompt) === 1 ? '' : 's'}` : ''}
          </Text>
        ) : null}
        {now?.isHeld ? <Text color="warning">auto kept the current effort to protect the cache</Text> : null}
      </Box>

      <Box flexDirection="row" gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          <Text bold dimColor>PRESET</Text>
        </Box>
        <Box width={MODEL_W + EFFORT_W + 1} flexShrink={0}>
        <Select
          key="preset"
          options={presetOptions}
          value={shown.preset}
          onSelect={value => {
            const preset = PRESETS[value]
            if (preset) void editDraft(c => ({ ...c, preset: value, routes: { ...preset.routes } }))
          }}
        />
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {GROUPS.map(group => (
          <Box key={`g:${group.title}`} flexDirection="column" marginBottom={1}>
            <Text bold dimColor>{group.title.toUpperCase()}</Text>
            {group.keys.map(key => {
              const row = ROUTES.find(one => one.key === key)!
              const setting = shown.routes[key] ?? { model: 'inherit', effort: 'inherit' }
              const isChild = key !== 'sub:*' && group.title === 'Subagents'
              const isLive = now?.route === key
              return (
                <Box key={`row:${key}`} flexDirection="row" gap={1}>
                  <Text color={changed.has(key) ? 'warning' : isLive ? colorOf(key) : 'subtle'}>
                    {changed.has(key) ? '●' : isLive ? '▸' : ' '}
                  </Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color={isChild ? undefined : colorOf(key)} bold={!isChild} wrap="truncate-end">
                      {isChild ? `└ ${PANE_LABEL[key] ?? row.label}` : (PANE_LABEL[key] ?? row.label)}
                    </Text>
                  </Box>
                  <Box width={MODEL_W} flexShrink={0}>
                    <Select
                      key={`m:${key}`}
                      options={MODEL_OPTIONS}
                      value={setting.model}
                      onSelect={value => void setRoute(key, { model: value as RouteSetting['model'] })}
                    />
                  </Box>
                  <Box width={EFFORT_W} flexShrink={0}>
                    <Select
                      key={`e:${key}`}
                      options={effortOptions(row.canAuto)}
                      value={setting.effort}
                      onSelect={value => void setRoute(key, { effort: value as RouteSetting['effort'] })}
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
            ● Draft — {changes.length} change{changes.length === 1 ? '' : 's'}, not applied
          </Text>
          {changes.map(one => (
            <Box key={`c:${one.route}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text color={colorOf(one.route)}>{PANE_LABEL[one.route] ?? one.route}</Text>
                <Text color={one.perTurnDelta <= 0 ? 'success' : 'error'}>
                  {signed(one.perTurnDelta)}/{one.route === 'main' || one.route === 'plan' ? 'turn' : 'run'}
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
            <Button
              key="apply"
              label="Apply"
              variant="primary"
              onPress={async () => {
                await update($, draft, () => null)
                await setConfig($, () => pending)
              }}
            />
            <Button
              key="discard"
              label="Discard"
              onPress={async () => {
                await update($, draft, () => null)
                await refreshStatus($)
              }}
            />
          </Box>
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold dimColor>SPEND THIS SESSION</Text>
          <Text bold>{money(total)}</Text>
        </Box>
        {spendRows.length === 0 && <Text dimColor>No requests yet.</Text>}
        {spendRows.map(([route, one]) => (
          <Box key={`s:${route}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Box width={2} flexShrink={0}>
                <Text color={colorOf(route)}>●</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color={colorOf(route)} wrap="truncate-end">{PANE_LABEL[route] ?? route}</Text>
              </Box>
              <Box width={7} flexShrink={0} justifyContent="flex-end">
                <Text bold>{money(one.usd)}</Text>
              </Box>
              <Box width={5} flexShrink={0} justifyContent="flex-end">
                <Text dimColor>{total > 0 ? `${Math.round((one.usd / total) * 100)}%` : ''}</Text>
              </Box>
            </Box>
            <Text dimColor>
              {'   '}
              {one.requests} req · in {kTokens(one.input)} · cache {kTokens(one.cacheRead)}/{kTokens(one.cacheWrite)} · out{' '}
              {kTokens(one.output)}
            </Text>
          </Box>
        ))}
        <Text dimColor>estimate · prices as of {PRICES_AS_OF} · cache writes at the {ttlMinutes === 60 ? '1-hour (2× input)' : '5-minute (1.25× input)'} rate</Text>
      </Box>
    </Box>
  )
}

const subagentCount = (p: PromptCost) => p.items.filter(one => one.id !== one.route).length

async function renderLastPane($: $, e: Args<'ui.render'>) {
  const p = await read($, promptCost)
  const { Box, Text } = $.ui.resolve(e)
  if (p === null || p.items.length === 0) return <Text dimColor>No requests in this prompt yet.</Text>
  const main = p.items.filter(one => one.id === one.route)
  const subs = p.items.filter(one => one.id !== one.route).sort((a, b) => b.usd - a.usd)
  const subTotal = subs.reduce((sum, one) => sum + one.usd, 0)
  const row = (one: PromptItem) => (
    <Box key={`i:${one.id}`} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          <Text color={colorOf(one.route)}>●</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={colorOf(one.route)} wrap="truncate-end">{one.label}</Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text bold>{money(one.usd)}</Text>
        </Box>
        <Box width={5} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{p.usd > 0 ? `${Math.round((one.usd / p.usd) * 100)}%` : ''}</Text>
        </Box>
      </Box>
      <Text dimColor>
        {'   '}
        {labelOf(one.model)}{one.effort ? ` ${one.effort}` : ''} · {one.requests} req · in {kTokens(one.input)} · cache {kTokens(one.cacheRead)}/{kTokens(one.cacheWrite)} · out {kTokens(one.output)}
      </Text>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Last prompt</Text>
        <Text bold>{money(p.usd)}</Text>
      </Box>
      <Text dimColor>
        {p.requests} requests · main {money(p.usd - subTotal)} · {subs.length} subagent{subs.length === 1 ? '' : 's'} {money(subTotal)}
      </Text>
      <Box flexDirection="column" gap={1}>
        {main.map(row)}
        {subs.map(row)}
      </Box>
      <Text dimColor>estimate · resets when you send the next prompt</Text>
    </Box>
  )
}

async function renderCtxPane($: $, e: Args<'ui.render'>) {
  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Open the context breakdown from a terminal or desktop.</Text>
  }
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  const columns = (e.component === 'Pane' ? e.props.bodyColumns : undefined) || 80
  const { context } = await $.session.usage({ breakdown: 'summary', columns })
  const b = context.breakdown
  if (b === undefined) return <Text dimColor>No context breakdown available yet.</Text>
  const used = b.categories.filter(one => one.kind === 'used').sort((x, y) => y.tokens - x.tokens)
  const deferred = b.categories.filter(one => one.kind === 'deferred')
  const free = b.categories.find(one => one.kind === 'free')
  const buffer = b.categories.find(one => one.kind === 'buffer')
  const servers = new Map<string, number>()
  for (const tool of b.mcpTools) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  const topServers = [...servers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)
  const topMemory = [...b.memoryFiles].sort((x, y) => y.tokens - x.tokens).slice(0, 5)
  const untilCompact = b.autoCompactThreshold === undefined ? undefined : b.autoCompactThreshold - b.totalTokens
  const pct = (tokens: number) => `${((tokens / b.rawMaxTokens) * 100).toFixed(1)}%`
  const isTerminal = e.surface === 'terminal'
  const width = Math.max(10, columns - 2)
  const segments: Segment[] = used.map(one => ({ tokens: one.tokens, color: one.color }))
  const line = (key: string, name: string, tokens: number, color?: string, isDim?: boolean) => (
    <Box key={key} flexDirection="row" gap={1}>
      <Box width={2} flexShrink={0}>
        <Text color={color} dimColor={isDim}>●</Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={isDim}>{kTokens(tokens)}</Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{pct(tokens)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text dimColor={isDim} wrap="truncate-end">{name}</Text>
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Context</Text>
        <Text bold color={contextLevel(b.totalTokens, b.rawMaxTokens, b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined)}>
          {kTokens(b.totalTokens)} / {kTokens(b.rawMaxTokens)} · {b.percentage}%
        </Text>
      </Box>
      {isTerminal || Svg === undefined ? (
        <Text>
          {stackedCells(segments, b.rawMaxTokens, width).map((one, i) => (
            <Text key={`c:${i}`} color={one.color} dimColor={one.color === undefined}>
              {one.text}
            </Text>
          ))}
        </Text>
      ) : (
        <Svg source={stackedSvg(segments, b.rawMaxTokens)} alt={`${b.percentage}% of the context window in use`} />
      )}
      <Text dimColor>
        {b.isAutoCompactEnabled && untilCompact !== undefined
          ? `auto-compact at ${kTokens(b.autoCompactThreshold ?? 0)} · ${kTokens(Math.max(0, untilCompact))} to go`
          : 'auto-compact off'}
      </Text>
      <Box flexDirection="column">
        <Text bold dimColor>IN USE</Text>
        {used.map(one => line(`u:${one.name}`, one.name, one.tokens, one.color))}
      </Box>
      <Box flexDirection="column">
        <Text bold dimColor>NOT SENT</Text>
        {deferred.map(one => line(`d:${one.name}`, one.name.replace(/ \(deferred\)$/, ''), one.tokens, undefined, true))}
        {free ? line('free', 'Free space', free.tokens, undefined, true) : null}
        {buffer ? line('buffer', 'Compaction buffer', buffer.tokens, undefined, true) : null}
      </Box>
      {topServers.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>MCP SERVERS</Text>
          {topServers.map(([name, tokens]) => line(`m:${name}`, name, tokens, 'suggestion'))}
        </Box>
      ) : null}
      {topMemory.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>MEMORY FILES</Text>
          {topMemory.map(one => line(`f:${one.path}`, `${one.type} · ${one.path.split('/').slice(-2).join('/')}`, one.tokens, 'planMode'))}
        </Box>
      ) : null}
      <Text dimColor>
        {b.skills ? `skills listing ${kTokens(b.skills.tokens)} (${b.skills.includedSkills}/${b.skills.totalSkills}) · ` : ''}
        {b.model} · estimated locally, as /context does
      </Text>
    </Box>
  )
}

async function setBand($: $, isShown: boolean) {
  await update($, isBandShown, () => isShown)
  await $.store.set('bandShown', isShown)
}

async function renderBand($: $, e: Args<'ui.render'>) {
  const cfg = await read($, config)
  const now = await read($, active)
  const pending = await read($, draft)
  const total = Object.values(await read($, spend)).reduce((sum, one) => sum + one.usd, 0)
  const { Box, Text, Button } = $.ui.resolve(e)
  const head = !cfg.isEnabled
    ? 'router off'
    : now
      ? `▸ ${now.route} · ${labelOf(now.model)}${now.effort ? ` ${now.effort}` : ''}${now.isHeld ? ' (held)' : ''}`
      : '▸ waiting for first request'
  const healthRow = await renderHealthRow($, e)
  return (
    <Box flexDirection="row" justifyContent="space-between" gap={1}>
      <Box flexDirection="column" flexShrink={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold={cfg.isEnabled} dimColor={!cfg.isEnabled} color={cfg.isEnabled && now ? colorOf(now.route) : undefined}>
            {head}
          </Text>
          <Text dimColor wrap="truncate-end">
            │ <Text color="planMode">plan</Text> {shortRoute(cfg, 'plan')} · <Text color="claude">main</Text> {shortRoute(cfg, 'main')} ·{' '}
            <Text color="suggestion">sub</Text> {shortRoute(cfg, 'sub:*')} · {money(total)}
          </Text>
          {pending ? <Text color="warning">● draft</Text> : null}
        </Box>
        {healthRow}
      </Box>
      <Box flexDirection="column" alignItems="flex-end" flexShrink={0}>
        <Button key="band-open" label="Routes" plain onPress={() => $.ui.open({ id: PANE, title: 'Model router' })} />
        <Button key="band-hide" label="Hide" plain onPress={() => setBand($, false)} />
      </Box>
    </Box>
  )
}

const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

type Decision = { model: string; effort?: Effort; isHeld: boolean }

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  autoEffort: new Map<string, Effort>(),
  decisions: new Map<string, Decision>(),
  lastMain: undefined as { route: string; model: string; effort?: Effort } | undefined,
  isAfterCompact: false,
  isNewPrompt: true,
  repo: 'unknown',
  pendingLabel: 'prompt',
  current: undefined as { label: string; text: string; at: number } | undefined,
  compactAt: undefined as number | undefined,
  compactCheckedAt: undefined as number | undefined,
  pendingWorkflow: 0,
}

async function routeOfAgent($: $, agentId: string): Promise<string | undefined> {
  const known = (await read($, agents))[agentId]
  if (known !== undefined) return known
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed !== undefined) {
    if (listed.teammateId !== undefined) return 'teammate'
    return listed.type === FORK ? FORK : `sub:${listed.type}`
  }
  return mem.pendingWorkflow > 0 ? 'workflow' : undefined
}

async function decideMain(
  $: $,
  turnId: string,
  index: number,
  route: string,
  model: string,
  effort?: Effort,
): Promise<Decision> {
  const known = mem.decisions.get(turnId)
  if (known !== undefined && index > 0) return known
  const want = resolve(await read($, config), route)
  const toModel = want.model ?? model
  let toEffort: Effort | undefined =
    want.effort === 'auto' ? (mem.autoEffort.get(turnId) ?? mem.lastMain?.effort ?? 'medium') : (want.effort ?? effort)
  let isHeld = false
  const last = mem.lastMain
  if (want.effort === 'auto' && last !== undefined && last.route === route) {
    const contextTokens = (await $.session.usage()).context.tokens ?? 0
    const from = { model: last.model, effort: last.effort }
    const to = { model: toModel, effort: toEffort }
    const ttlMinutes = (await read($, config)).cacheTtlMinutes ?? DEFAULT_TTL
    if (!shouldSwitch({ contextTokens, isAfterCompact: mem.isAfterCompact, from, to, ttlMinutes })) {
      toEffort = last.effort
      isHeld = true
    }
  }
  mem.isAfterCompact = false
  mem.autoEffort.delete(turnId)
  const decision = { model: toModel, effort: toEffort, isHeld }
  mem.decisions.clear()
  mem.decisions.set(turnId, decision)
  return decision
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get(STORE_KEY)) as RouterConfig | undefined
    if (stored?.routes) await update($, config, () => ({ ...DEFAULT_CONFIG, ...stored }))
    const saved = await $.store.get('history')
    if (Array.isArray(saved)) await update($, history, () => saved as PromptRecord[])
    const scope = await $.store.get('statsScope')
    if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
    const repo = await $.session.repo().catch(() => null)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    mem.repo = repo?.name ?? (root.split('/').pop() || 'unknown')
    const band = await $.store.get('bandShown')
    if (typeof band === 'boolean') await update($, isBandShown, () => band)
    $.ui.status(undefined)
    await refreshStatus($)
    $.clock.every(60_000, () => void refreshStatus($))
    await $.command.register({
      name: 'route',
      description: 'Model router: open the pane, or `preset <name>`, `set <route> <model> [effort]`, `on`, `off`, `band on|off`',
      argumentHint: '[preset <name> | set <route> <model> [effort] | on | off | band on|off]',
    })
    return next(e)
  })

  on('prompt.attachment', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (e.type === 'plan_mode' || e.type === 'plan_mode_reentry') await update($, isPlan, () => true)
      if (e.type === 'plan_mode_exit') await update($, isPlan, () => false)
    }
    return next(e)
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await update($, isPlan, () => true)
    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && !ran.isError) await update($, isPlan, () => false)
    return ran
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) mem.isAfterCompact = true
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const route = routeForSpawn(e)
    const { model } = resolve(await read($, config), route)
    const canRewrite = route !== FORK && e.workflow === undefined
    if (e.workflow !== undefined) mem.pendingWorkflow += 1
    const started = await next(canRewrite && model ? { ...e, model } : e)
    if (e.workflow !== undefined) mem.pendingWorkflow = Math.max(0, mem.pendingWorkflow - 1)
    const id = started.agentId
    if (id !== undefined) {
      await update($, agents, map => ({ ...map, [id]: route }))
      await update($, agentLabels, map => ({ ...map, [id]: `${e.subagentType} · ${e.description}` }))
    }
    return started
  })

  on('prompt.submit', ($, e, next) => {
    if (e.turnId === undefined) {
      mem.isNewPrompt = true
      mem.pendingLabel = commandLabel(e.text)
    }
    return next(e)
  })

  on('command.run', ($, e, next) => {
    if (e.origin.kind !== 'plugin' && e.command !== 'route') {
      mem.isNewPrompt = true
      mem.pendingLabel = `/${e.command}`
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await recordPrompt($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (mem.isNewPrompt) {
      mem.isNewPrompt = false
      await recordPrompt($)
      mem.current = { label: mem.pendingLabel, text: e.text.slice(0, 120), at: await $.clock.now().catch(() => Date.now()) }
      mem.pendingLabel = 'prompt'
      await update($, promptCost, () => ({ usd: 0, requests: 0, items: [] }))
    }
    const route = (await read($, isPlan)) ? 'plan' : 'main'
    const { effort } = resolve(await read($, config), route)
    if (effort === 'auto' && e.text.trim() !== '') {
      const label = await $.model
        .classify(e.text.slice(0, 4000), AUTO_LABELS, { model: 'haiku' })
        .catch(() => undefined)
      mem.autoEffort.set(e.turnId, effortForLabel(label, e.text))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const cfg = await read($, config)
    let route: string | undefined
    let model = e.model
    let effort = asEffort(e.effort)
    let isHeld = false

    if (e.agentId === undefined) {
      route = (await read($, isPlan)) ? 'plan' : 'main'
      if (cfg.isEnabled) {
        const decision = await decideMain($, e.turnId, e.index, route, e.model, effort)
        model = decision.model
        effort = decision.effort
        isHeld = decision.isHeld
      }
    } else {
      route = await routeOfAgent($, e.agentId)
      if (route !== undefined && route !== FORK) {
        const want = resolve(cfg, route)
        model = want.model ?? e.model
        if (want.effort !== undefined && want.effort !== 'auto') effort = want.effort
      }
    }

    const isChanged = model !== e.model || effort !== asEffort(e.effort)
    const result = yield* next(isChanged ? { ...e, model, ...(effort ? { effort } : {}) } : e)

    const key = route ?? 'sub:?'
    const stepAt = await $.clock.now().catch(() => Date.now())
    if (result.usage) {
      const usage = result.usage
      const ttl = cfg.cacheTtlMinutes ?? DEFAULT_TTL
      await update($, spend, all => ({ ...all, [key]: addSpend(all[key] ?? EMPTY_SPEND, usage, usage.model, ttl) }))
      const itemId = e.agentId ?? key
      const label = e.agentId === undefined ? (key === 'plan' ? 'Main loop (plan mode)' : 'Main loop') : ((await read($, agentLabels))[e.agentId] ?? key)
      const usd = costOf(usage, usage.model, ttl)
      const stepEffort = typeof effort === 'string' ? effort : undefined
      await update($, promptCost, p => {
        const was = p ?? { usd: 0, requests: 0, items: [] }
        const old: PromptItem = was.items.find(one => one.id === itemId) ?? {
          id: itemId, route: key, label, model: usage.model, requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0,
        }
        const item: PromptItem = {
          ...old,
          model: usage.model,
          ...(stepEffort ? { effort: stepEffort } : {}),
          requests: old.requests + 1,
          input: old.input + usage.input_tokens,
          cacheRead: old.cacheRead + usage.cache_read_input_tokens,
          cacheWrite: old.cacheWrite + usage.cache_creation_input_tokens,
          output: old.output + usage.output_tokens,
          usd: old.usd + usd,
        }
        const items = was.items.some(one => one.id === itemId)
          ? was.items.map(one => (one.id === itemId ? item : one))
          : [...was.items, item]
        return { usd: was.usd + usd, requests: was.requests + 1, items }
      })
      if (e.agentId === undefined) {
        await update($, lastUsage, () => ({
          model: usage.model,
          input: usage.input_tokens,
          cacheRead: usage.cache_read_input_tokens,
          cacheWrite: usage.cache_creation_input_tokens,
          usd: costOf(usage, usage.model, ttl),
          at: stepAt,
        }))
      }
    }

    if (e.agentId === undefined) {
      if (mem.lastMain !== undefined && mem.lastMain.route !== key && cfg.isEnabled) {
        $.ui.toast(`Route ${key}: ${labelOf(model)}${effort ? ` ${effort}` : ''}`)
      }
      mem.lastMain = { route: key, model, effort }
      await update($, active, () => ({ route: key, model, effort, isHeld }))
    }
    await refreshStatus($)
    return result
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb, ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (verb === undefined) {
      await $.ui.open({ id: PANE, title: 'Model router' })
      return { text: 'Model router pane opened.' }
    }
    if (verb === 'ttl') {
      const minutes = Number(rest[0])
      if (minutes !== 5 && minutes !== 60) return { text: 'Usage: /route ttl 5|60 (prompt-cache lifetime in minutes)' }
      await setConfig($, c => ({ ...c, cacheTtlMinutes: minutes }))
      return { text: `Cache lifetime set to ${minutes} minutes.` }
    }
    if (verb === 'band') {
      const isShown = rest[0] !== 'off'
      await setBand($, isShown)
      return { text: `Model router band ${isShown ? 'shown' : 'hidden'}.` }
    }
    if (verb === 'on' || verb === 'off') {
      await setConfig($, c => ({ ...c, isEnabled: verb === 'on' }))
      return { text: `Model router ${verb === 'on' ? 'enabled' : 'disabled'}.` }
    }
    if (verb === 'preset') {
      const name = rest[0] ?? ''
      const preset = PRESETS[name]
      if (preset === undefined) return { text: `Presets: ${Object.keys(PRESETS).join(', ')}.` }
      await setConfig($, c => ({ ...c, preset: name, routes: { ...preset.routes } }))
      return { text: `Preset ${name}: ${preset.label}.` }
    }
    if (verb === 'set') {
      const [route, model, effort] = rest
      if (route === undefined) return { text: `Routes: ${ROUTES.map(one => one.key).join(', ')}, or sub:<agent-type>.` }
      const setting = parseSetting(model, effort)
      if (typeof setting === 'string') return { text: setting }
      await setConfig($, c => ({ ...c, preset: 'custom', routes: { ...c.routes, [route]: setting } }))
      return { text: `${route} → ${setting.model} · ${setting.effort}.` }
    }
    return { text: 'Usage: /route [preset <name> | set <route> <model> [effort] | on | off | band on|off]' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'Pane', requestId: LAST_PANE }, ($, e) => renderLastPane($, e))

  on('ui.render', { component: 'Pane', requestId: CTX_PANE }, ($, e) => renderCtxPane($, e))

  on('ui.render', { component: 'Pane', requestId: STATS_PANE }, ($, e) => renderStatsPane($, e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode') return next(e)
    const tree = await renderStatsFooter($, e, e.props.modes)
    return tree ?? next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)
    return renderBand($, e)
  })
}
