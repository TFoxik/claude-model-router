import { atom, read, update } from 'claude-code'
import type { Args, BoxProps, ElementConstructor, EngineInterface, Register, Timer } from 'claude-code'

import type { ActiveRoute, ColdGuard, Effort, Health, LastUsage, PromptCost, PromptRecord, Rewrite, RouteSetting, RouteSpend, RouterConfig } from '../types'
import {
  AUTO_LABELS,
  DEFAULT_CONFIG,
  EFFORTS,
  EMPTY_PROMPT,
  EMPTY_SPEND,
  FORK,
  GUARD_MIN_TOKENS,
  HISTORY_LIMIT,
  MODELS,
  PRESETS,
  PRICES_AS_OF,
  ROUTES,
  SUB_CONTEXT,
  addSpend,
  addStep,
  coldForMs,
  commandLabel,
  commandStats,
  contextLevel,
  costOf,
  effortForLabel,
  estimateChanges,
  fmtAge,
  isLoopRoute,
  labelOf,
  modeSwitchCost,
  modelMix,
  modelsOf,
  money,
  parseSetting,
  plural,
  presetOf,
  printable,
  resolve,
  rewriteCause,
  rewriteOf,
  rewritePrice,
  routeForSpawn,
  routeLabel,
  routeText,
  sanitizeConfig,
  sanitizeHistory,
  shortLabel,
  shouldSwitch,
  subagentCount,
  sumUsd,
  todayUsd,
} from './routes'

const PANE = 'model-router'
const LAST_PANE = 'model-router-last'
const CTX_PANE = 'model-router-ctx'
const STATS_PANE = 'model-router-stats'

const config = atom({ plugin: 'model-router', key: 'config' } as const, DEFAULT_CONFIG)
const spend = atom({ plugin: 'model-router', key: 'spend' } as const, {} as Record<string, RouteSpend>)
const isPlan = atom({ plugin: 'model-router', key: 'isPlan' } as const, false)
const active = atom({ plugin: 'model-router', key: 'active' } as const, null as ActiveRoute | null)
const draft = atom({ plugin: 'model-router', key: 'draft' } as const, null as RouterConfig | null)
const lastUsage = atom({ plugin: 'model-router', key: 'lastUsage' } as const, null as LastUsage | null)
const health = atom({ plugin: 'model-router', key: 'health' } as const, null as Health | null)
const history = atom({ plugin: 'model-router', key: 'history' } as const, [] as PromptRecord[])
const statsScope = atom({ plugin: 'model-router', key: 'statsScope' } as const, 'repo' as 'repo' | 'all')
const promptCost = atom({ plugin: 'model-router', key: 'promptCost' } as const, null as PromptCost | null)
const isBandShown = atom({ plugin: 'model-router', key: 'isBandShown' } as const, true)

type $ = EngineInterface

// The store keys the atoms kept across sessions are saved under. The engine's
// scan needs each update() to name its atom, so callers update, then save().
const STORE = { config: 'config', history: 'history', statsScope: 'statsScope', bandShown: 'bandShown' } as const

/** Saves a value kept across sessions; a failed save keeps the session going. */
async function save<T>($: $, key: string, value: T): Promise<T> {
  await $.store.set(key, value).catch(() => undefined)
  return value
}

export async function setConfig(
  $: $,
  fn: (c: RouterConfig) => RouterConfig,
): Promise<RouterConfig> {
  const next = await save($, STORE.config, await update($, config, fn))
  await refreshStatus($)
  return next
}

const nowOf = ($: $) => $.clock.now().catch(() => Date.now())

const mainRoute = async ($: $) => ((await read($, isPlan)) ? 'plan' : 'main')

const shortRoute = (cfg: RouterConfig, route: string) => {
  const r = resolve(cfg, route)
  return `${r.model ? shortLabel(labelOf(r.model)) : 'inherit'}${r.effort ? ` ${r.effort}` : ''}`
}

async function routedMainModel($: $, cfg: RouterConfig, fallback: string): Promise<string> {
  return resolve(cfg, await mainRoute($)).model ?? fallback
}

const promptTokens = (last: LastUsage) => last.input + last.cacheRead + last.cacheWrite

/** The price of the next main-loop send when the cache has gone cold over a big context. */
async function coldSend($: $, cfg: RouterConfig): Promise<{ at: number; text: string } | undefined> {
  const last = await read($, lastUsage)
  if (last === null) return undefined
  const ttl = cfg.cacheTtlMinutes
  const coldFor = coldForMs(last.at, await nowOf($), ttl)
  if (coldFor < 0) return undefined
  const context = (await $.session.usage()).context.tokens ?? promptTokens(last)
  if (context < GUARD_MIN_TOKENS) return undefined
  const model = await routedMainModel($, cfg, last.model)
  const { write, warm } = rewritePrice(model, context, ttl)
  return {
    at: last.at,
    text: `the prompt cache went cold ${fmtAge(coldFor)} ago. This send re-writes ~${kTokens(context)} tokens on ${labelOf(model)} = ${money(write)} (warm would be ${money(warm)}).`,
  }
}

async function refreshStatus($: $) {
  const last = await read($, lastUsage)
  if (last === null) return
  const { context, rateLimits } = await $.session.usage()
  const tokens = context.tokens ?? promptTokens(last)
  const prompt = promptTokens(last)
  const five = rateLimits.find(one => one.kind === 'five_hour')
  const seven = rateLimits.find(one => one.kind === 'seven_day')
  const now = await nowOf($)
  const cfg = await read($, config)
  const ttl = cfg.cacheTtlMinutes
  const warmMinutes = Math.max(0, Math.ceil(-coldForMs(last.at, now, ttl) / 60_000))
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
    ...(warmMinutes === 0 && tokens >= GUARD_MIN_TOKENS
      ? { coldUsd: rewritePrice(await routedMainModel($, cfg, last.model), tokens, ttl).write }
      : {}),
    ...(five ? { fiveHour: Math.round(five.percentUsed) } : {}),
    ...(seven ? { sevenDay: Math.round(seven.percentUsed) } : {}),
  }
  await update($, health, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
}

const level = (value: number, warn: number, bad: number) => (value >= bad ? 'error' : value >= warn ? 'warning' : undefined)

function recordOf(meta: { label: string; text: string; at: number }, p: PromptCost): PromptRecord {
  return {
    at: meta.at,
    repo: mem.repo,
    label: meta.label,
    text: meta.text,
    usd: p.usd,
    requests: p.requests,
    agents: subagentCount(p),
    models: modelsOf(p),
    rewrites: p.rewrites,
  }
}

const CAUSE_LABEL: Record<Rewrite['cause'], string> = { cold: 'cold cache', switch: 'route switch' }

const rewriteText = (one: Rewrite) => `${CAUSE_LABEL[one.cause]} rewrite of ${kTokens(one.tokens)} tokens, ${money(one.usd)}`

async function recordPrompt($: $) {
  const p = await read($, promptCost)
  const meta = mem.current
  mem.current = undefined
  if (p === null || meta === undefined || p.usd <= 0) return
  const rec = recordOf(meta, p)
  await save($, STORE.history, await update($, history, all => [...all, rec].slice(-HISTORY_LIMIT)))
}

type Els = ReturnType<$['ui']['resolve']>

/** A pane row: a coloured dot, a name that truncates, the cost right-aligned, an optional share and dim sub-lines. */
function ledgerRow(
  { Box, Text }: Els,
  r: { key: string; color?: string; name: string; usd: number; share?: number; nameColor?: string; sub?: ReadonlyArray<string | undefined> },
) {
  const sub = (r.sub ?? []).filter(Boolean)
  return (
    <Box key={r.key} flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>
          <Text color={r.color}>●</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={r.nameColor} wrap="truncate-end">{r.name}</Text>
        </Box>
        <Box width={8} flexShrink={0} justifyContent="flex-end">
          <Text bold>{money(r.usd)}</Text>
        </Box>
        {r.share === undefined ? null : (
          <Box width={5} flexShrink={0} justifyContent="flex-end">
            <Text dimColor>{`${Math.round(r.share * 100)}%`}</Text>
          </Box>
        )}
      </Box>
      {sub.length > 0 ? <Text dimColor>{`   ${sub.join('\n   ')}`}</Text> : null}
    </Box>
  )
}

const tokenLine = (one: RouteSpend) =>
  `${one.requests} req · in ${kTokens(one.input)} · cache ${kTokens(one.cacheRead)}/${kTokens(one.cacheWrite)} · out ${kTokens(one.output)}`

async function renderStatsFooter($: $, e: Args<'ui.render'>, modes: readonly string[]) {
  const { Box, Text, Button } = $.ui.resolve(e)
  const [all, live, now] = await Promise.all([read($, history), read($, promptCost), nowOf($)])
  const today = todayUsd(all, now) + (live?.usd ?? 0)
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
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const scope = await read($, statsScope)
  const saved = await read($, history)
  const live = await read($, promptCost)
  const current = mem.current
  const all = live && current && live.usd > 0 ? [...saved, recordOf(current, live)] : saved
  const records = scope === 'repo' ? all.filter(r => r.repo === mem.repo) : all
  const now = await nowOf($)
  const today = todayUsd(records, now)
  const week = sumUsd(records.filter(r => now - r.at < 7 * 86_400_000))
  const rewrites = records.flatMap(r => r.rewrites ?? [])
  const commands = commandStats(records).slice(0, 10)
  const priciest = [...records].sort((x, y) => y.usd - x.usd).slice(0, 8)
  const setScope = async (next: 'repo' | 'all') => save($, STORE.statsScope, await update($, statsScope, () => next))
  const day = (at: number) => {
    const d = new Date(at)
    return `${d.getDate()}.${d.getMonth() + 1}.`
  }
  const colorOfLabel = (label: string) => (label === 'prompt' ? 'subtle' : 'suggestion')
  const shownText = (r: PromptRecord) => (r.label === 'prompt' ? r.text : `${r.label} ${r.text.replace(r.label, '').trim()}`.trim())
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
        today {money(today)} · 7 days {money(week)} · all {money(sumUsd(records))} · {plural(records.length, 'prompt')}
        {rewrites.length > 0 ? ` · ${plural(rewrites.length, 'cache rewrite')} ${money(sumUsd(rewrites))}` : ''}
      </Text>
      {records.length === 0 ? (
        <Text dimColor>Nothing recorded yet.</Text>
      ) : (
        <>
          <Box flexDirection="column">
            <Text bold dimColor>COMMANDS · AVERAGE PER RUN</Text>
            {commands.map(c =>
              ledgerRow(els, {
                key: `c:${c.label}`,
                color: colorOfLabel(c.label),
                name: c.label,
                usd: c.avg,
                sub: [`${plural(c.runs, 'run')} · total ${money(c.total)} · max ${money(c.max)}`, modelMix(c.models, money)],
              }),
            )}
          </Box>
          <Box flexDirection="column">
            <Text bold dimColor>MOST EXPENSIVE PROMPTS</Text>
            {priciest.map((r, i) =>
              ledgerRow(els, {
                key: `p:${i}`,
                color: colorOfLabel(r.label),
                name: shownText(r),
                usd: r.usd,
                sub: [
                  [day(r.at), scope === 'all' ? r.repo : undefined, `${r.requests} req`, plural(r.agents, 'subagent'), ...(r.rewrites ?? []).map(rewriteText)].filter(Boolean).join(' · '),
                  modelMix(r.models, money),
                ],
              }),
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
  const limits = [['5h', hp.fiveHour], ['7d', hp.sevenDay]].filter((one): one is [string, number] => one[1] !== undefined)
  return (
    <Box flexDirection="row">
      <Text dimColor>
        {'cache '}
        {hp.warmMinutes === 0 ? (
          <Text color="error">{hp.coldUsd === undefined ? 'cold' : `cold ${money(hp.coldUsd)}`}</Text>
        ) : (
          <Text>
            <Text color={cacheColor}>{hp.cache}%</Text> <Text color={hp.warmMinutes <= 5 ? 'warning' : undefined}>{hp.warmMinutes}m</Text>
          </Text>
        )}
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
      {limits.length === 0 ? null : (
        <Text dimColor>
          {limits.map(([name, pct]) => (
            <Text key={`l:${name}`}>
              {`  ·  ${name} `}
              <Text color={level(pct, 70, 90)}>{pct}%</Text>
            </Text>
          ))}
        </Text>
      )}
    </Box>
  )
}

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

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

const ROUTE_COLOR: Record<string, string> = { plan: 'planMode', main: 'claude' }
const colorOf = (route: string) => ROUTE_COLOR[route] ?? 'suggestion'

const GROUPS = [
  { title: 'Main loop', rows: ROUTES.filter(one => isLoopRoute(one.key)) },
  { title: 'Subagents', rows: ROUTES.filter(one => !isLoopRoute(one.key)) },
]

const INHERIT: RouteSetting = { model: 'inherit', effort: 'inherit' }

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
  const [cfg, costs, now, isPlanning] = await Promise.all([read($, config), read($, spend), read($, active), read($, isPlan)])

  if (e.surface === 'mobile') {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color={now ? colorOf(now.route) : undefined} bold>
          {now ? `▸ ${now.route} · ${routeText(now.model, now.effort)}` : '▸ waiting'}
        </Text>
        <Text dimColor>Edit routes with /route set, or from a terminal or desktop.</Text>
      </Box>
    )
  }
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Select } = els

  const [pending, lastPrompt] = await Promise.all([read($, draft), read($, promptCost)])
  const shown = pending ?? cfg
  const contextTokens = (await $.session.usage()).context.tokens ?? 0
  const sessionModel = now?.model ?? (await $.session.model())
  const liveRoute = isPlanning ? 'plan' : 'main'
  const ttlMinutes = cfg.cacheTtlMinutes
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
  }
  const setRoute = (route: string, patch: Partial<RouteSetting>) =>
    editDraft(c => {
      const was = c.routes[route] ?? INHERIT
      return { ...c, preset: 'custom', routes: { ...c.routes, [route]: { ...was, ...patch } } }
    })
  const signed = (usd: number) => `${usd >= 0 ? '+' : '−'}${money(Math.abs(usd))}`

  const presetOptions = [
    ...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
    ...(presetOf(shown.preset) ? [] : [{ value: shown.preset, label: 'Custom' }]),
  ]

  const spendRows = Object.entries(costs).sort((a, b) => b[1].usd - a[1].usd)
  const total = sumUsd(spendRows.map(([, one]) => one))
  const subs = lastPrompt ? subagentCount(lastPrompt) : 0
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
        <Box flexGrow={1} flexShrink={1}>
          <Text bold dimColor>PRESET</Text>
        </Box>
        <Box width={MODEL_W + EFFORT_W + 1} flexShrink={0}>
        <Select
          key="preset"
          options={presetOptions}
          value={shown.preset}
          onSelect={value => {
            const preset = presetOf(value)
            if (preset) void editDraft(c => ({ ...c, preset: value, routes: { ...preset.routes } }))
          }}
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
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color={isChild ? undefined : colorOf(key)} bold={!isChild} wrap="truncate-end">
                      {isChild ? `└ ${row.label}` : row.label}
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
                      options={effortOptions(isLoopRoute(key))}
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
              onPress={() => update($, draft, () => null)}
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
        <Box flexDirection="column" gap={1}>
          {spendRows.map(([route, one]) =>
            ledgerRow(els, {
              key: `s:${route}`,
              color: colorOf(route),
              nameColor: colorOf(route),
              name: routeLabel(route),
              usd: one.usd,
              share: total > 0 ? one.usd / total : 0,
              sub: [tokenLine(one)],
            }),
          )}
        </Box>
        <Text dimColor>estimate · prices as of {PRICES_AS_OF} · cache writes at the {ttlMinutes === 60 ? '1-hour (2× input)' : '5-minute (1.25× input)'} rate</Text>
      </Box>
    </Box>
  )
}

async function renderLastPane($: $, e: Args<'ui.render'>) {
  const p = await read($, promptCost)
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  if (p === null || p.items.length === 0) return <Text dimColor>No requests in this prompt yet.</Text>
  const main = p.items.filter(one => one.id === one.route)
  const subs = p.items.filter(one => one.id !== one.route).sort((a, b) => b.usd - a.usd)
  const subTotal = sumUsd(subs)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Last prompt</Text>
        <Text bold>{money(p.usd)}</Text>
      </Box>
      <Text dimColor>
        {plural(p.requests, 'request')} · main {money(p.usd - subTotal)} · {plural(subs.length, 'subagent')} {money(subTotal)}
      </Text>
      {(p.rewrites ?? []).map((one, i) => (
        <Text key={`rw:${i}`} color="warning">includes a {rewriteText(one)}</Text>
      ))}
      <Box flexDirection="column" gap={1}>
        {[...main, ...subs].map(one =>
          ledgerRow(els, {
            key: `i:${one.id}`,
            color: colorOf(one.route),
            nameColor: colorOf(one.route),
            name: one.label,
            usd: one.usd,
            share: p.usd > 0 ? one.usd / p.usd : 0,
            sub: [`${routeText(one.model, one.effort)} · ${tokenLine(one)}`],
          }),
        )}
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
          {topServers.map(([name, tokens]) => line(`m:${name}`, printable(name), tokens, 'suggestion'))}
        </Box>
      ) : null}
      {topMemory.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>MEMORY FILES</Text>
          {topMemory.map(one => line(`f:${one.path}`, printable(`${one.type} · ${one.path.split('/').slice(-2).join('/')}`), one.tokens, 'planMode'))}
        </Box>
      ) : null}
      <Text dimColor>
        {b.skills ? `skills listing ${kTokens(b.skills.tokens)} (${b.skills.includedSkills}/${b.skills.totalSkills}) · ` : ''}
        {b.model} · estimated locally, as /context does
      </Text>
    </Box>
  )
}

const setBand = async ($: $, isShown: boolean) => save($, STORE.bandShown, await update($, isBandShown, () => isShown))

function bandHead(cfg: RouterConfig, now: ActiveRoute | null): string {
  if (!cfg.isEnabled) return 'router off'
  if (now === null) return '▸ waiting for first request'
  return `▸ ${now.route} · ${routeText(now.model, now.effort)}${now.isHeld ? ' (held)' : ''}`
}

async function renderBand($: $, e: Args<'ui.render'>) {
  const [cfg, now, pending, costs] = await Promise.all([read($, config), read($, active), read($, draft), read($, spend)])
  const total = sumUsd(Object.values(costs))
  const { Box, Text, Button } = $.ui.resolve(e)
  const head = bandHead(cfg, now)
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

const GUARD_TEXT: Record<ColdGuard, string> = {
  refuse: 'Cold sends are dropped once with their price; the resend goes through.',
  warn: 'Cold sends go through with their price shown.',
  off: 'Cold-send guard off.',
}

const asEffort = (effort: unknown): Effort | undefined =>
  typeof effort === 'string' ? (effort as Effort) : undefined

const PANES = {
  route: { id: PANE, title: 'Model router' },
  stats: { id: STATS_PANE, title: 'Stats' },
  context: { id: CTX_PANE, title: 'Context' },
  last: { id: LAST_PANE, title: 'Last prompt cost' },
} as const

const USAGE = '[stats [clear] | context | last | preset <name> | set <route> <model> [effort] | on | off | band on|off | guard refuse|warn|off | ttl 5|60]'

// Origins a person typed or drove; a peer, channel or trigger may not change the routes.
const USER_ORIGINS: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])

type Decision = { model: string; effort?: Effort; isHeld: boolean }

// Per-load memory: a hot reload starts it over, which only costs one unguarded turn.
const mem = {
  autoEffort: new Map<string, Effort>(),
  decisions: new Map<string, Decision>(),
  lastMain: undefined as { route: string; model: string; effort?: Effort; at: number } | undefined,
  isAfterCompact: false,
  repo: 'unknown',
  // The label of the prompt the next turn.start opens; undefined while a prompt's turns run.
  pendingPrompt: 'prompt' as string | undefined,
  agents: new Map<string, { route: string; label?: string }>(),
  tick: undefined as Timer | undefined,
  current: undefined as { label: string; text: string; at: number } | undefined,
  compactAt: undefined as number | undefined,
  compactCheckedAt: undefined as number | undefined,
  pendingWorkflow: 0,
  coldAckedAt: undefined as number | undefined,
}

async function routeOfAgent($: $, agentId: string): Promise<string | undefined> {
  const known = mem.agents.get(agentId)
  if (known !== undefined) return known.route
  const listed = (await $.agent.list()).find(one => one.id === agentId)
  if (listed !== undefined) {
    const route = listed.teammateId !== undefined ? 'teammate' : listed.type === FORK ? FORK : `sub:${listed.type}`
    mem.agents.set(agentId, { route })
    return route
  }
  return mem.pendingWorkflow > 0 ? 'workflow' : undefined
}

async function decideMain(
  $: $,
  cfg: RouterConfig,
  turnId: string,
  index: number,
  route: string,
  model: string,
  isAfterCompact: boolean,
  effort?: Effort,
): Promise<Decision> {
  const known = mem.decisions.get(turnId)
  if (known !== undefined && index > 0) return known
  const want = resolve(cfg, route)
  const toModel = want.model ?? model
  let toEffort: Effort | undefined =
    want.effort === 'auto' ? (mem.autoEffort.get(turnId) ?? mem.lastMain?.effort ?? 'medium') : (want.effort ?? effort)
  let isHeld = false
  const last = mem.lastMain
  if (want.effort === 'auto' && last !== undefined && last.route === route) {
    const contextTokens = (await $.session.usage()).context.tokens ?? 0
    const from = { model: last.model, effort: last.effort }
    const to = { model: toModel, effort: toEffort }
    if (!shouldSwitch({ contextTokens, isAfterCompact, from, to, ttlMinutes: cfg.cacheTtlMinutes })) {
      toEffort = last.effort
      isHeld = true
    }
  }
  mem.autoEffort.delete(turnId)
  const decision = { model: toModel, effort: toEffort, isHeld }
  mem.decisions.clear()
  mem.decisions.set(turnId, decision)
  return decision
}

type StepOutcome = {
  cfg: RouterConfig
  model: string
  effort?: Effort
  isHeld: boolean
  isAfterCompact: boolean
  usage: (Parameters<typeof costOf>[0] & { model: string }) | null | undefined
}

/** Counts one finished request: per-route spend, the prompt's breakdown, and, for the main loop, the band's facts. */
async function recordStep($: $, agentId: string | undefined, key: string, s: StepOutcome) {
  const stepAt = await nowOf($)
  const isMain = agentId === undefined
  const usage = s.usage
  if (usage) {
    const ttl = s.cfg.cacheTtlMinutes
    const label = isMain ? (key === 'plan' ? 'Main loop (plan mode)' : 'Main loop') : (mem.agents.get(agentId)?.label ?? key)
    const cause = isMain
      ? rewriteCause({ isAfterCompact: s.isAfterCompact, prevAt: mem.lastMain?.at, now: stepAt, ttlMinutes: ttl, from: mem.lastMain, to: { model: s.model, effort: s.effort } })
      : undefined
    const rewrite = rewriteOf(usage, usage.model, cause, ttl)
    await update($, spend, all => ({ ...all, [key]: addSpend(all[key] ?? EMPTY_SPEND, usage, usage.model, ttl) }))
    await update($, promptCost, p => addStep(p ?? EMPTY_PROMPT, { id: agentId ?? key, route: key, label, effort: s.effort, usage, ttlMinutes: ttl, rewrite }))
    if (isMain) {
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
  if (!isMain) return
  if (mem.lastMain !== undefined && mem.lastMain.route !== key && s.cfg.isEnabled) $.ui.toast(`Route ${key}: ${routeText(s.model, s.effort)}`)
  mem.lastMain = { route: key, model: s.model, effort: s.effort, at: stepAt }
  await update($, active, () => ({ route: key, model: s.model, effort: s.effort, isHeld: s.isHeld }))
  await refreshStatus($)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const get = (key: string) => $.store.get(key).catch(() => undefined)
    const [stored, saved, scope, band, repo] = await Promise.all([
      get(STORE.config),
      get(STORE.history),
      get(STORE.statsScope),
      get(STORE.bandShown),
      $.session.repo().catch(() => null),
    ])
    const cfg = stored === undefined ? DEFAULT_CONFIG : sanitizeConfig(stored)
    await update($, config, () => cfg)
    await update($, history, () => sanitizeHistory(saved))
    if (scope === 'repo' || scope === 'all') await update($, statsScope, () => scope)
    if (typeof band === 'boolean') await update($, isBandShown, () => band)
    const root = repo?.root ?? (await $.session.root().catch(() => ''))
    mem.repo = repo?.name ?? (root.split('/').pop() || 'unknown')
    $.ui.status(undefined)
    await refreshStatus($).catch(() => undefined)
    mem.tick?.cancel()
    mem.tick = $.clock.every(60_000, () => void refreshStatus($).catch(() => undefined))
    await $.command.register({ name: 'route', description: 'Model router: open the pane, or one of the verbs', argumentHint: USAGE })
    const hasCacheTax = cfg.coldGuard !== 'off' && (await $.command.list().catch(() => [])).some(one => one.name === 'cache-tax')
    if (hasCacheTax) {
      $.ui.log('model-router: cache-tax is installed too, so a cold send is guarded twice. Run /route guard off to leave it to cache-tax.')
    }
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
    if (started.agentId !== undefined) mem.agents.set(started.agentId, { route, label: printable(`${e.subagentType} · ${e.description}`) })
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      const cfg = await read($, config)
      const guard = cfg.coldGuard
      if (guard !== 'off' && e.origin.kind !== 'plugin' && !e.text.trimStart().startsWith('/')) {
        const cold = await coldSend($, cfg).catch(() => undefined)
        if (cold !== undefined && guard === 'warn') $.ui.log(`model-router: ${cold.text} Sending anyway.`)
        if (cold !== undefined && guard === 'refuse' && mem.coldAckedAt !== cold.at) {
          mem.coldAckedAt = cold.at
          return { drop: `model-router: ${cold.text} Send it again to pay it, or /clear and start from a note.` }
        }
      }
      mem.pendingPrompt = commandLabel(e.text)
    }
    return next(e)
  })

  on('command.run', ($, e, next) => {
    if (e.origin.kind !== 'plugin' && e.command !== 'route') mem.pendingPrompt = `/${e.command}`
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await recordPrompt($).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (mem.pendingPrompt !== undefined) {
      const label = mem.pendingPrompt
      mem.pendingPrompt = undefined
      await recordPrompt($).catch(() => undefined)
      mem.current = { label, text: printable(e.text.slice(0, 120)), at: await nowOf($) }
      await update($, promptCost, () => EMPTY_PROMPT)
    }
    const { effort } = resolve(await read($, config), await mainRoute($))
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
    const isAfterCompact = e.agentId === undefined && mem.isAfterCompact

    if (e.agentId === undefined) {
      mem.isAfterCompact = false
      route = await mainRoute($)
      if (cfg.isEnabled) {
        const decision = await decideMain($, cfg, e.turnId, e.index, route, e.model, isAfterCompact, effort)
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

    // Bookkeeping never fails the request it is counting.
    await recordStep($, e.agentId, route ?? 'sub:?', { cfg, model, effort, isHeld, isAfterCompact, usage: result.usage }).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const [verb = 'route', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (Object.hasOwn(PANES, verb) && rest.length === 0) {
      const pane = PANES[verb as keyof typeof PANES]
      await $.ui.open(pane)
      return { text: `${pane.title} pane opened.` }
    }
    if (!USER_ORIGINS.has(e.origin.kind)) return { text: `model-router: /route ${verb} only runs when you type it.` }
    if (verb === 'stats' && rest[0] === 'clear') {
      await save($, STORE.history, await update($, history, () => []))
      return { text: 'Prompt history cleared.' }
    }
    if (verb === 'ttl') {
      const minutes = Number(rest[0])
      if (minutes !== 5 && minutes !== 60) return { text: 'Usage: /route ttl 5|60 (prompt-cache lifetime in minutes)' }
      await setConfig($, c => ({ ...c, cacheTtlMinutes: minutes }))
      return { text: `Cache lifetime set to ${minutes} minutes.` }
    }
    if (verb === 'guard') {
      const mode = rest[0] as ColdGuard
      if (!Object.hasOwn(GUARD_TEXT, mode ?? '')) return { text: 'Usage: /route guard refuse|warn|off (what a send onto a cold prompt cache does)' }
      await setConfig($, c => ({ ...c, coldGuard: mode }))
      return { text: GUARD_TEXT[mode] }
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
      const preset = presetOf(name)
      if (preset === undefined) return { text: `Presets: ${Object.keys(PRESETS).join(', ')}.` }
      await setConfig($, c => ({ ...c, preset: name, routes: { ...preset.routes } }))
      return { text: `Preset ${name}: ${preset.label}.` }
    }
    if (verb === 'set') {
      const [route, model, effort] = rest
      if (route === undefined) return { text: `Routes: ${ROUTES.map(one => one.key).join(', ')}, or sub:<agent-type>.` }
      const setting = parseSetting(route, model, effort)
      if (typeof setting === 'string') return { text: setting }
      await setConfig($, c => ({ ...c, preset: 'custom', routes: { ...c.routes, [route]: setting } }))
      return { text: `${route} → ${setting.model} · ${setting.effort}.` }
    }
    return { text: `Usage: /route ${USAGE}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))

  on('ui.render', { component: 'Pane', requestId: LAST_PANE }, ($, e) => renderLastPane($, e))

  on('ui.render', { component: 'Pane', requestId: CTX_PANE }, ($, e) => renderCtxPane($, e))

  on('ui.render', { component: 'Pane', requestId: STATS_PANE }, ($, e) => renderStatsPane($, e))

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.component !== 'SessionMode') return next(e)
    return renderStatsFooter($, e, e.props.modes)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isBandShown))) return next(e)
    return renderBand($, e)
  })
}
