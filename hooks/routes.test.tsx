import type { Args, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Lesson } from '../types'
import { HANDOFF_PROMPT } from './handoff'
import { stamp } from './ui/kit'

import {
  DEFAULT_CONFIG,
  FORK,
  MODELS,
  PRESETS,
  SMALL_CONTEXT,
  commandLabel,
  commandStats,
  contextLevel,
  addStep,
  costOf,
  effortForLabel,
  parseSetting,
  presetOf,
  printable,
  typedText,
  sanitizeConfig,
  sanitizeHistory,
  startingConfig,
  todayUsd,
  withPreset,
  fmtAge,
  rewriteCause,
  rewriteOf,
  rewritePrice,
  estimateChanges,
  modeSwitchCost,
  resolve,
  routeForSpawn,
  shouldSwitch,
  labelOf,
} from './routes'

const opus = MODELS.opus.id
const sonnet = MODELS.sonnet.id
const haiku = MODELS.haiku.id
const MINE = withPreset(DEFAULT_CONFIG, 'mine')!
const PANE_IDS = { route: 'model-router', last: 'model-router-last', context: 'model-router-ctx', stats: 'model-router-stats', learn: 'model-router-learn', handoffs: 'model-router-handoffs' } as const
const mountPane = ($: Engine, pane: keyof typeof PANE_IDS, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'model-router', surface, component: 'Pane', requestId: PANE_IDS[pane], props: {} as never })
const useMine = ($: Engine) => $.command.run({ command: 'route', args: 'preset mine', origin: { kind: 'composer' } } as unknown as Args<'command.run'>)

test('plan falls back to main, sub:<type> to sub:*', () => {
  const config = { ...DEFAULT_CONFIG, routes: { main: { model: 'opus', effort: 'medium' }, 'sub:*': { model: 'sonnet', effort: 'high' } } } as const
  const cfg = { ...config, routes: { ...config.routes } }
  expect(resolve(cfg, 'plan')).toEqual({ model: opus, effort: 'medium' })
  expect(resolve(cfg, 'sub:Explore')).toEqual({ model: sonnet, effort: 'high' })
  expect(resolve(cfg, 'sub:my-custom-agent')).toEqual({ model: sonnet, effort: 'high' })
  expect(resolve(cfg, 'workflow')).toEqual({ model: sonnet, effort: 'high' })
})

test('a fresh install inherits everything; an install with history keeps mine', () => {
  expect(resolve(DEFAULT_CONFIG, 'main')).toEqual({ model: undefined, effort: undefined })
  expect(resolve(DEFAULT_CONFIG, 'sub:Explore')).toEqual({ model: undefined, effort: undefined })
  expect(startingConfig(undefined, false)).toBe(DEFAULT_CONFIG)
  expect(startingConfig(undefined, true)).toEqual(MINE)
  expect(startingConfig({ routes: { main: { model: 'haiku', effort: 'low' } } }, true).routes).toEqual({ main: { model: 'haiku', effort: 'low' } })
  expect(resolve(MINE, 'main')).toEqual({ model: opus, effort: 'medium' })
  expect(resolve(MINE, 'plan')).toEqual({ model: opus, effort: 'high' })
  expect(resolve(MINE, 'sub:general-purpose')).toEqual({ model: sonnet, effort: 'high' })
})

test('a route left inherit everywhere changes nothing, and forks are never routed', () => {
  const cfg = { ...DEFAULT_CONFIG, routes: {} }
  expect(resolve(cfg, 'main')).toEqual({ model: undefined, effort: undefined })
  expect(resolve(DEFAULT_CONFIG, FORK)).toEqual({})
  expect(resolve({ ...DEFAULT_CONFIG, isEnabled: false }, 'main')).toEqual({})
})

test('spawns map to routes', () => {
  expect(routeForSpawn({ subagentType: 'Explore', fork: false })).toBe('sub:Explore')
  expect(routeForSpawn({ subagentType: 'fork', fork: true })).toBe(FORK)
  expect(routeForSpawn({ subagentType: 'general-purpose', fork: false, workflow: { runId: 'wf_1', agentIndex: 1 } })).toBe('workflow')
  expect(routeForSpawn({ subagentType: 'teammate', fork: false, isTeammate: true })).toBe('teammate')
})

test('every preset names only known models', () => {
  for (const preset of Object.values(PRESETS)) {
    for (const setting of Object.values(preset.routes)) {
      expect(setting.model === 'inherit' || setting.model in MODELS).toBe(true)
    }
  }
})

test('auto effort from the classifier label', () => {
  expect(effortForLabel('trivial', 'fix typo')).toBe('low')
  expect(effortForLabel('standard', 'explain this')).toBe('medium')
  expect(effortForLabel('hard', 'redesign the rollback flow')).toBe('high')
  expect(effortForLabel('hard', 'refactor the installer')).toBe('xhigh')
  expect(effortForLabel(undefined, 'anything')).toBe('medium')
})

test('switch guard: upgrades go, small or freshly compacted contexts go, big downgrades hold', () => {
  const from = { model: opus, effort: 'high' as const }
  const down = { model: opus, effort: 'low' as const }
  expect(shouldSwitch({ contextTokens: 500_000, isAfterCompact: false, from: down, to: from })).toBe(true)
  expect(shouldSwitch({ contextTokens: SMALL_CONTEXT - 1, isAfterCompact: false, from, to: down })).toBe(true)
  expect(shouldSwitch({ contextTokens: 500_000, isAfterCompact: true, from, to: down })).toBe(true)
  expect(shouldSwitch({ contextTokens: 500_000, isAfterCompact: false, from, to: down })).toBe(false)
  expect(shouldSwitch({ contextTokens: 25_000, isAfterCompact: false, from, to: down })).toBe(false)
  expect(shouldSwitch({ contextTokens: 25_000, isAfterCompact: false, from: { model: opus, effort: 'xhigh' }, to: down })).toBe(true)
  expect(shouldSwitch({ contextTokens: 25_000, isAfterCompact: false, from, to: down, ttlMinutes: 5 })).toBe(true)
})

test('cost uses the model the API reports', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  expect(costOf(usage, opus)).toBe(24)
  expect(costOf(usage, haiku)).toBe(0.6)
  expect(costOf(usage, 'something-else')).toBe(0)
})

type Sent = { model: string; effort?: unknown; agentId?: string }

function bottomStep(on: On, sent: Sent[]) {
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

async function step($: Engine, turnId: string, agentId?: string) {
  const e: Args<'turn.step'> = { turnId, index: 0, model: sonnet, effort: 'max', messageCount: 1, ...(agentId ? { agentId } : {}) }
  const stream = $.turn.step(e)
  for await (const _chunk of stream) {
    // drain
  }
  return stream.result
}

async function attach($: Engine, type: 'plan_mode' | 'plan_mode_exit') {
  const detail = type === 'plan_mode'
    ? { reminder: 'full' as const, planFilePath: '/p.md', hasPlan: false }
    : { planFilePath: '/p.md', hasPlan: false }
  await $.prompt.attachment({ type, text: 'x', origin: { kind: 'engine' }, detail } as Args<'prompt.attachment'>)
}

test('main and plan turns get their own model and effort', async ($, on) => {
  mock.store(on)
  const sent: Sent[] = []
  bottomStep(on, sent)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await useMine($)

  await step($, 't1')
  await attach($, 'plan_mode')
  await step($, 't2')
  await attach($, 'plan_mode_exit')
  await step($, 't3')

  expect(sent.map(one => [one.model, one.effort])).toEqual([
    [opus, 'medium'],
    [opus, 'high'],
    [opus, 'medium'],
  ])
})

test('subagents are routed by type at spawn and at every step', async ($, on) => {
  mock.store(on)
  const sent: Sent[] = []
  bottomStep(on, sent)
  const spawned: Array<string | undefined> = []
  on('agent.spawn', (_$, e) => {
    spawned.push(e.model)
    return { model: e.model ?? e.parentModel, agentId: `a-${spawned.length}` }
  })

  const spawn = (subagentType: string, fork = false) =>
    $.agent.spawn({
      tool_use_id: 'tu',
      prompt: 'p',
      description: 'd',
      subagentType,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: opus,
      background: false,
      fork,
    } as Args<'agent.spawn'>)

  await useMine($)
  await spawn('Explore')
  await spawn('fork', true)
  await step($, 's1', 'a-1')
  await step($, 's2', 'a-2')

  expect(spawned).toEqual([sonnet, undefined])
  expect(sent).toEqual([
    { model: sonnet, effort: 'high', agentId: 'a-1' },
    { model: sonnet, effort: 'max', agentId: 'a-2' },
  ])
})

test('auto mode classifies the prompt and sets the main effort', async ($, on) => {
  mock.store(on, { config: { ...DEFAULT_CONFIG, preset: 'balanced', routes: PRESETS.balanced!.routes } })
  const sent: Sent[] = []
  bottomStep(on, sent)
  on('model.classify', (_$, e) => ({ value: e.text.includes('typo') ? 'trivial' : 'hard' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.turn.start({ text: 'fix typo in readme', turnId: 'u1' })
  await step($, 'u1')
  await $.turn.start({ text: 'refactor the autoupdate rollback', turnId: 'u2' })
  await step($, 'u2')

  expect(sent.map(one => [one.model, one.effort])).toEqual([
    [opus, 'low'],
    [opus, 'xhigh'],
  ])
})

test('the pane draws on terminal and desktop', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100_000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: opus }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'Pane', requestId: 'model-router', props: {} as never })
    expect(await ui.find({ key: 'm:main' })).toBeDefined()
    expect(await ui.find({ key: 'e:plan' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band above the prompt draws and hides', async ($, on) => {
  mock.store(on, { bandShown: true, config: MINE })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => { const { Text } = $.ui.resolve(e); return <Text key="engine-band">engine</Text> })
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.find({ type: 'Text', text: /Opus medium/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Sonnet high/ })).toBeDefined()
    expect(await ui.find({ key: 'band-open' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await ui.press({ key: 'band-hide' })
  expect(await ui.find({ key: 'band-open' })).toBeUndefined()
  await ui.unmount()
})

test('estimates: only the live main-loop route pays a cache rewrite up front', () => {
  const next = { ...MINE, routes: { ...MINE.routes, main: { model: 'sonnet', effort: 'low' }, 'sub:*': { model: 'haiku', effort: 'low' } } } as typeof MINE
  const rows = estimateChanges(MINE, next, { contextTokens: 100_000, liveRoute: 'main', sessionModel: opus, ttlMinutes: 60 })
  const main = rows.find(one => one.route === 'main')!
  const sub = rows.find(one => one.route === 'sub:*')!
  expect(Math.abs(main.switchCost - 0.38)).toBeLessThan(1e-9)
  expect(main.perTurnDelta).toBeLessThan(0)
  expect(sub.switchCost).toBe(0)
  expect(sub.perTurnDelta).toBeLessThan(0)
  expect(rows.some(one => one.route === 'plan')).toBe(false)
  expect(Math.abs(modeSwitchCost(MINE, 100_000, opus) - 0.78)).toBeLessThan(1e-9)
  expect(Math.abs(modeSwitchCost({ ...MINE, cacheTtlMinutes: 5 }, 100_000, opus) - 0.48)).toBeLessThan(1e-9)
})

test('pane edits stay a draft until Apply', async ($, on) => {
  mock.store(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 100_000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.model', () => ({ value: opus }))
  const sent: Sent[] = []
  bottomStep(on, sent)
  await useMine($)
  const ui = await mountPane($, 'route')
  await ui.select({ key: 'm:main', value: 'sonnet' })
  expect(await ui.find({ key: 'apply' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^cache .* now$/ })).toBeDefined()
  await step($, 'd1')
  await ui.press({ key: 'apply' })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  await step($, 'd2')
  expect(sent.map(one => one.model)).toEqual([opus, sonnet])
  await ui.unmount()
})

test('footer shows cache, context and the 5h window', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.parse('2026-10-08T10:00:00Z') })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 100_000, window: 1_000_000, percent: 10 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 38.4, resetsAt: '2026-10-08T12:10:00Z' }, { kind: 'seven_day', percentUsed: 12 }],
    },
  }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-modes">engine</Text>
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: opus, input_tokens: 1000, cache_read_input_tokens: 96_000, cache_creation_input_tokens: 3000, output_tokens: 500 },
    }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  await step($, 'h1')
  expect((await ui.find({ key: 'stats' }))?.text).toMatch(/^▤ today \$/)
  const band = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await band.find({ type: 'Text', text: 'cache 96% 60m  ·  ' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '  ·  5h 38%  ·  7d 12%' })).toBeDefined()
  expect((await band.find({ key: 'ctx' }))?.text).toBe('context')
  expect((await band.find({ key: 'last-cost' }))?.text).toBe('last $0.06')
  await band.unmount()
  await clock.advance(61 * 60_000)
  const band2 = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await band2.find({ type: 'Text', text: /^cache cold/ })).toBeDefined()
  await band2.unmount()
  await ui.unmount()
})

test('last is the whole prompt: main steps and its subagents, reset on the next prompt', async ($, on) => {
  mock.store(on)
  const usage = { model: opus, input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [] } }))
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-modes">engine</Text>
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('agent.spawn', (_$, e) => ({ model: e.model ?? opus, agentId: 'sub-1' }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })

  await $.prompt.submit({ text: '/simplify', origin: { kind: 'composer' } } as Args<'prompt.submit'>)
  await $.turn.start({ text: 'simplify', turnId: 'p1' })
  await step($, 'p1')
  await $.agent.spawn({ tool_use_id: 'tu', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: opus, background: false, fork: false } as Args<'agent.spawn'>)
  await step($, 's1', 'sub-1')
  await step($, 's1', 'sub-1')
  await step($, 'p1')
  expect((await ui.find({ key: 'last-cost' }))?.text).toBe('last $0.02')
  const breakdown = await mountPane($, 'last')
  expect(await breakdown.find({ type: 'Text', text: '2 requests · main $0.0080 · 1 subagent $0.0080' })).toBeUndefined()
  expect(await breakdown.find({ type: 'Text', text: '4 requests · main $0.0080 · 1 subagent $0.0080' })).toBeDefined()
  expect(await breakdown.find({ type: 'Text', text: 'Main loop' })).toBeDefined()
  expect(await breakdown.find({ type: 'Text', text: 'general-purpose · d' })).toBeDefined()
  await breakdown.unmount()

  await $.prompt.submit({ text: 'next', origin: { kind: 'composer' } } as Args<'prompt.submit'>)
  await $.turn.start({ text: 'next', turnId: 'p2' })
  await step($, 'p2')
  expect((await ui.find({ key: 'last-cost' }))?.text).toBe('last $0.0040')
  await ui.unmount()
})

test('the context pane breaks the window down', async ($, on) => {
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 120_000,
        window: 1_000_000,
        percent: 12,
        breakdown: {
          categories: [
            { name: 'Messages', tokens: 80_000, color: 'claude', isDeferred: false, kind: 'used' },
            { name: 'System tools', tokens: 30_000, color: 'subtle', isDeferred: false, kind: 'used' },
            { name: 'MCP tools', tokens: 9000, color: 'suggestion', isDeferred: true, kind: 'deferred' },
            { name: 'Free space', tokens: 800_000, color: 'subtle', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 120_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model-default',
          percentage: 12,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [{ path: '/Users/x/repo/CLAUDE.md', type: 'Project', tokens: 2000 }],
          mcpTools: [
            { name: 'search', serverName: 'jira', tokens: 4000 },
            { name: 'get', serverName: 'jira', tokens: 1000 },
          ],
          agents: [],
          autoCompactThreshold: 900_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    } as never,
  }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'model-router', surface, component: 'Pane', requestId: 'model-router-ctx', props: {} as never })
    expect(await ui.find({ type: 'Text', text: '120k / 1000k · 12%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'jira' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /780k to go/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'TIPS' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /MCP server jira loads 5k/ })).toBeDefined()
    expect(await ui.find({ type: surface === 'desktop' ? 'Svg' : 'Text', text: surface === 'desktop' ? undefined : /█/ })).toBeDefined()
    await ui.unmount()
  }
})

test('context colour follows distance to auto-compaction', () => {
  expect(contextLevel(500_000, 1_000_000)).toBe('success')
  expect(contextLevel(700_000, 1_000_000)).toBe('warning')
  expect(contextLevel(900_000, 1_000_000)).toBe('error')
  expect(contextLevel(500_000, 1_000_000, 800_000)).toBe('warning')
  expect(contextLevel(700_000, 1_000_000, 800_000)).toBe('error')
})

test('commands are labelled and ranked by average cost', () => {
  expect(commandLabel('/simplify the auth module')).toBe('/simplify')
  expect(commandLabel('fix the typo')).toBe('prompt')
  const stats = commandStats([
    { at: 0, repo: 'r', label: '/simplify', text: '', usd: 2, requests: 1, agents: 4 },
    { at: 0, repo: 'r', label: '/simplify', text: '', usd: 4, requests: 1, agents: 4 },
    { at: 0, repo: 'r', label: 'prompt', text: '', usd: 1, requests: 1, agents: 0 },
  ])
  expect(stats.map(one => [one.label, one.runs, one.avg, one.max])).toEqual([
    ['/simplify', 2, 3, 4],
    ['prompt', 1, 1, 1],
  ])
})

test('finished prompts are saved across sessions and shown in Stats', async ($, on) => {
  mock.store(on, { config: MINE })
  const usage = { model: opus, input_tokens: 250_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 0 }, rateLimits: [] } }))
  on('session.repo', () => ({ value: { root: '/x/my-app', remote: null, internal: true, name: 'my-app' } as never }))
  on('session.root', () => ({ value: '/x/my-app' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({}) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  await $.prompt.submit({ text: '/simplify hooks', origin: { kind: 'composer' } } as Args<'prompt.submit'>)
  await $.turn.start({ text: '/simplify hooks', turnId: 'a' })
  await step($, 'a')
  await $.prompt.submit({ text: 'fix typo', origin: { kind: 'composer' } } as Args<'prompt.submit'>)
  await $.turn.start({ text: 'fix typo', turnId: 'b' })

  const ui = await mountPane($, 'stats')
  expect(await ui.find({ type: 'Text', text: 'Stats · my-app' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/simplify' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 run · total \$1\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus 5\.5 medium \$1\.00/ })).toBeDefined()
  await ui.unmount()
})

test('rewrites: only a big write with a cause counts, priced above a warm read', () => {
  const write = { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 100_000 }
  expect(rewriteOf(write, opus, 'cold')).toEqual({ cause: 'cold', tokens: 100_000, usd: 0.78 })
  expect(rewriteOf(write, opus, undefined)).toBeUndefined()
  expect(rewriteOf({ ...write, cache_creation_input_tokens: 10_000 }, opus, 'cold')).toBeUndefined()
  expect(rewriteOf({ ...write, cache_read_input_tokens: 150_000 }, opus, 'switch')).toBeUndefined()
  expect(rewritePrice(sonnet, 200_000)).toEqual({ write: 0.8, warm: 0.04, premium: 0.76 })
  expect(rewritePrice(sonnet, 200_000, 5).write).toBe(0.5)
  expect([fmtAge(60_000), fmtAge(72 * 60_000)]).toEqual(['1m', '1h12m'])
})

test('rewrite cause: expiry, then a route change, never right after compaction', () => {
  const hour = 60 * 60_000
  const base = { isAfterCompact: false, now: 2 * hour, ttlMinutes: 60, to: { model: opus, effort: 'medium' as const } }
  expect(rewriteCause({ ...base, prevAt: 0 })).toBe('cold')
  expect(rewriteCause({ ...base, prevAt: 1.5 * hour, from: { model: sonnet, effort: 'medium' } })).toBe('switch')
  expect(rewriteCause({ ...base, prevAt: 1.5 * hour, from: { model: opus, effort: 'high' } })).toBe('switch')
  expect(rewriteCause({ ...base, prevAt: 1.5 * hour, from: base.to })).toBeUndefined()
  expect(rewriteCause({ ...base, prevAt: 0, isAfterCompact: true })).toBeUndefined()
})

type StepUsage = { model: string; input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number }

const usageOf = (read: number, write = 0): StepUsage => ({ model: opus, input_tokens: 0, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 0 })

/** A session whose context size and step usage the test can change as it goes. */
function guardSession(on: On, facts: { context: number; usage: StepUsage }) {
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: facts.context, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: facts.usage }
  })
}

const submit = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as Args<'prompt.submit'>)
const route = ($: Engine, args: string) => $.command.run({ command: 'route', args, origin: { kind: 'composer' } } as unknown as Args<'command.run'>)
const T0 = Date.parse('2026-10-08T10:00:00Z')

test('a cold send over a big context is dropped once, priced on the routed model', async ($, on) => {
  mock.store(on, { config: { ...DEFAULT_CONFIG, routes: { ...DEFAULT_CONFIG.routes, main: { model: 'sonnet', effort: 'medium' } } } })
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 200_000, usage: usageOf(200_000) })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'a')
  expect((await submit($, 'warm')).drop).toBeUndefined()
  await clock.advance(61 * 60_000)
  const band = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await band.find({ type: 'Text', text: /^cache cold \$0\.80/ })).toBeDefined()
  await band.unmount()
  expect((await submit($, '/simplify')).drop).toBeUndefined()
  for (const kind of ['plugin', 'task-notification', 'scheduled-trigger', 'peer']) {
    expect((await $.prompt.submit({ text: 'x', origin: { kind } } as unknown as Args<'prompt.submit'>)).drop).toBeUndefined()
  }
  const refused = await submit($, 'recap')
  expect(refused.drop).toBe('model-router: the prompt cache went cold 1m ago. This send re-writes ~200k tokens on Sonnet 5.5 = $0.80 (warm would be $0.04). Send it again to pay it, or /clear and start from a note.')
  expect((await submit($, 'recap')).drop).toBeUndefined()
})

test('the guard skips small contexts, and can warn or be switched off', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on, { now: T0 })
  const facts = { context: 40_000, usage: usageOf(40_000) }
  guardSession(on, facts)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'a')
  await clock.advance(61 * 60_000)
  expect((await submit($, 'small')).drop).toBeUndefined()
  facts.context = 200_000
  for (const mode of ['warn', 'off']) {
    await route($, `guard ${mode}`)
    expect((await submit($, 'recap')).drop).toBeUndefined()
  }
})

test('cache rewrites are tallied by cause and shown in Last and Stats', async ($, on) => {
  mock.store(on, { config: { ...MINE, coldGuard: 'off' } })
  const clock = mock.clock(on, { now: T0 })
  const warm = usageOf(100_000)
  const rebuilt = usageOf(0, 100_000)
  const facts = { context: 100_000, usage: warm }
  guardSession(on, facts)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('session.compact', (_$, e) => ({ messages: e.messages }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const prompt = async (id: string, usage: StepUsage) => {
    facts.usage = usage
    await submit($, id)
    await $.turn.start({ text: id, turnId: id })
    await step($, id)
  }

  await prompt('a', warm)
  await clock.advance(61 * 60_000)
  await prompt('cold', rebuilt)
  const last = await mountPane($, 'last')
  expect(await last.find({ type: 'Text', text: 'includes a cold cache rewrite of 100k tokens, $0.78' })).toBeDefined()
  expect(await last.find({ type: 'Text', text: /^The cache had gone cold, which cost \$0\.78/ })).toBeDefined()
  await last.unmount()

  await prompt('b', warm)
  await attach($, 'plan_mode')
  await prompt('switch', rebuilt)
  await attach($, 'plan_mode_exit')
  await $.session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as unknown as Args<'session.compact'>)
  await clock.advance(61 * 60_000)
  await prompt('after-compact', rebuilt)
  await prompt('done', warm)

  const stats = await mountPane($, 'stats')
  expect(await stats.find({ type: 'Text', text: /^↻ 2 cache rewrites \$1\.56$/ })).toBeDefined()
  expect(await stats.find({ type: 'Text', text: /^↻ route switch rewrite of 100k tokens, \$0\.78$/ })).toBeDefined()
  expect(await stats.find({ type: 'Text', text: /^Cache rewrites cost \$1\.56/ })).toBeDefined()
  await stats.unmount()
})

test('stored config is kept only where this version understands it', () => {
  expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG)
  const cfg = sanitizeConfig({
    isEnabled: false,
    routes: { main: { model: 'sonnet', effort: 'low' }, plan: { model: 'gpt', effort: 'low' }, 'sub:x': { model: 'haiku', effort: 'bogus' }, nope: { model: 'opus', effort: 'low' } },
    cacheTtlMinutes: 7,
    coldGuard: 'maybe',
    isLearning: 'yes',
  })
  expect(cfg).toEqual({ ...DEFAULT_CONFIG, isEnabled: false, routes: { main: { model: 'sonnet', effort: 'low' } } })
  expect(sanitizeConfig({ routes: { main: { model: 'constructor', effort: 'low' } } }).routes).toEqual(DEFAULT_CONFIG.routes)
  expect(sanitizeConfig({ autoHandoff: true }).autoHandoff).toBe(true)
  expect(sanitizeConfig({ autoHandoff: 'yes' }).autoHandoff).toBe(false)
  expect(DEFAULT_CONFIG.autoHandoff).toBe(false)
  expect(sanitizeConfig({ showNext: false }).showNext).toBe(false)
  expect(sanitizeConfig({ showNext: 'no' }).showNext).toBe(true)
  expect(DEFAULT_CONFIG.showNext).toBe(true)
  const good = { at: 1, repo: 'r', label: 'prompt', text: 't', usd: 1, requests: 1, agents: 0 }
  expect(sanitizeHistory([good, null, { ...good, text: 3 }, 'x'])).toEqual([good])
  expect(sanitizeHistory({})).toEqual([])
})

test('route, model, effort and preset names are checked as own keys', () => {
  expect(parseSetting('main', 'constructor', 'low')).toMatch(/Unknown model/)
  expect(parseSetting('Explore', 'haiku', 'low')).toMatch(/Unknown route/)
  expect(parseSetting('sub:Explore', 'haiku', 'auto')).toMatch(/main and plan only/)
  expect(parseSetting('sub:my-agent', 'haiku', 'low')).toEqual({ model: 'haiku', effort: 'low' })
  expect(parseSetting('plan', 'opus', 'auto')).toEqual({ model: 'opus', effort: 'auto' })
  expect([presetOf('constructor'), presetOf('__proto__')]).toEqual([undefined, undefined])
  expect(presetOf('max')?.label).toBe('Max quality')
  expect(printable('a\u001b[31mb\nc')).toBe('a [31mb c')
})

test('names the panes show reach them without terminal control characters', () => {
  expect(commandLabel('/x\u001b]0;title\u0007 now')).toBe('/x')
  expect(routeForSpawn({ subagentType: 'odd\u001b[2J', fork: false })).toBe('sub:odd [2J')
  expect(labelOf('model\u001b[2J')).toBe('model [2J')
  const dirty = { at: 1, repo: 'r\u001b', label: '/a\u0007', text: 't\u001b[31m', usd: 1, requests: 1, agents: 0 }
  expect(sanitizeHistory([dirty])).toEqual([{ ...dirty, repo: 'r ', label: '/a ', text: 't [31m' }])
})

test('prompt text drops the tags Claude Code wraps commands, agent messages and reminders in', () => {
  const command = '<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>and commit</command-args>'
  expect(typedText(command)).toBe('/simplify and commit')
  expect(typedText(command.slice(0, 50))).toBe('')
  expect(typedText('<agent-message from="a1b2"> [Subagent hand-back] The report')).toBe('agent message')
  expect(typedText('<system-reminder>be brief</system-reminder>\nfix the <div> layout')).toBe('fix the <div> layout')
  expect(typedText('go ahead')).toBe('go ahead')
})

test('a step adds to its item once, in place', () => {
  const usage = { model: opus, input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
  const one = addStep({ usd: 0, requests: 0, items: [] }, { id: 'main', route: 'main', label: 'Main loop', effort: 'high', usage, ttlMinutes: 60 })
  const two = addStep(one, { id: 'main', route: 'main', label: 'Main loop', usage, ttlMinutes: 60 })
  expect(two.items).toHaveLength(1)
  expect(two.items[0]).toMatchObject({ requests: 2, input: 2_000_000, usd: 8, effort: 'high' })
  expect([two.usd, two.requests]).toEqual([8, 2])
  expect(two.items[0]!.isMixed).toBeUndefined()
  const three = addStep(two, { id: 'main', route: 'main', label: 'Main loop', usage: { ...usage, model: sonnet }, ttlMinutes: 60 })
  expect(three.items[0]).toMatchObject({ model: sonnet, isMixed: true })
})

test('today sums only the tail of time-ordered history', () => {
  const day = 86_400_000
  const records = [0, day, 2 * day, 2 * day + 1000].map((at, i) => ({ at: T0 - 2 * day + at, repo: 'r', label: 'prompt', text: '', usd: i + 1, requests: 1, agents: 0 }))
  expect(todayUsd(records, T0 + 1000)).toBe(7)
})

test('only a person can change routes; anyone can open a pane; stats clear empties history', async ($, on) => {
  mock.store(on, { history: [{ at: T0, repo: 'unknown', label: 'prompt', text: 'x', usd: 1, requests: 1, agents: 0 }] })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const run = (args: string, kind: string) => $.command.run({ command: 'route', args, origin: { kind } } as unknown as Args<'command.run'>)
  expect((await run('off', 'peer')).text).toMatch(/only runs when you type it/)
  expect((await run('stats', 'peer')).text).toBe('Stats pane opened.')
  const mountStats = () => mountPane($, 'stats')
  const before = await mountStats()
  expect(await before.find({ type: 'Text', text: /^1 prompt$/ })).toBeDefined()
  await before.unmount()
  expect((await run('stats clear', 'composer')).text).toBe('Prompt history cleared.')
  const after = await mountStats()
  expect(await after.find({ type: 'Text', text: 'Nothing recorded yet.' })).toBeDefined()
  await after.unmount()
})

test('prompt text can be switched off, which also blanks what was kept', async ($, on) => {
  const kept = { at: T0, repo: 'unknown', label: 'prompt', text: 'secret plan', usd: 1, requests: 1, agents: 0 }
  mock.store(on, { history: [kept] })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect((await route($, 'stats text off')).text).toMatch(/saved prompt text was removed/)
  for (const text of ['another secret', 'next']) {
    await submit($, text)
    await $.turn.start({ text, turnId: text })
    await step($, text)
  }
  const stats = await mountPane($, 'stats')
  expect(await stats.find({ type: 'Text', text: /^3 prompts$/ })).toBeDefined()
  expect(await stats.find({ type: 'Text', text: /secret/ })).toBeUndefined()
  await stats.unmount()
})

test('an install with history but no saved config keeps routing as mine', async ($, on) => {
  mock.store(on, { history: [{ at: T0, repo: 'r', label: 'prompt', text: '', usd: 1, requests: 1, agents: 0 }] })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const sent: Sent[] = []
  bottomStep(on, sent)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'a')
  expect(sent.map(one => [one.model, one.effort])).toEqual([[opus, 'medium']])
})

test('Apply takes only the routing from the draft', async ($, on) => {
  mock.store(on, { config: MINE })
  guardSession(on, { context: 100_000, usage: usageOf(100_000) })
  on('session.model', () => ({ value: opus }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const ui = await mountPane($, 'route')
  await ui.select({ key: 'm:main', value: 'sonnet' })
  await route($, 'ttl 5')
  await ui.press({ key: 'apply' })
  expect(await ui.find({ key: 'apply' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /5-minute/ })).toBeDefined()
  expect(await ui.find({ key: 'm:main' })).toMatchObject({ props: { value: 'sonnet' } })
  await ui.unmount()
})

const record = (text: string, at = T0) => ({ at, repo: 'unknown', label: 'prompt', text, usd: 1, requests: 1, agents: 0 })

/** A store the test can read and change, as another session sharing it would. */
function sharedStore(on: On, data: Record<string, unknown>, unreadable = new Set<string>()) {
  on('store.get', (_$, e) => {
    if (unreadable.has(e.key)) throw new Error('store busy')
    return { value: data[e.key] }
  })
  on('store.set', (_$, e) => {
    data[e.key] = e.value
    return { value: undefined }
  })
}

test('saves merge with what another session stored meanwhile', async ($, on) => {
  const data: Record<string, unknown> = { config: MINE, history: [record('mine')] }
  sharedStore(on, data)
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  data.history = [record('mine'), record('from the other session')]
  data.config = { ...MINE, cacheTtlMinutes: 5 }
  for (const text of ['this session', 'next']) {
    await submit($, text)
    await $.turn.start({ text, turnId: text })
    await step($, text)
  }
  expect((data.history as Array<{ text: string }>).map(r => r.text)).toEqual(['mine', 'from the other session', 'this session'])
  await route($, 'guard warn')
  expect(data.config).toMatchObject({ cacheTtlMinutes: 5, coldGuard: 'warn' })
  await route($, 'stats text off')
  expect((data.history as Array<{ text: string }>).every(r => r.text === '')).toBe(true)
})

test('a failed store read never saves over what is stored', async ($, on) => {
  const custom = { ...MINE, coldGuard: 'warn' }
  const data: Record<string, unknown> = { config: custom, history: [record('kept')] }
  const unreadable = new Set(['config', 'history'])
  sharedStore(on, data, unreadable)
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.log', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (const text of ['a', 'b']) {
    await submit($, text)
    await $.turn.start({ text, turnId: text })
    await step($, text)
  }
  await route($, 'set main haiku low')
  expect(data).toEqual({ config: custom, history: [record('kept')] })
})

test('Apply keeps an on/off change made while the draft was open', async ($, on) => {
  mock.store(on, { config: MINE })
  guardSession(on, { context: 100_000, usage: usageOf(100_000) })
  on('session.model', () => ({ value: opus }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const ui = await mountPane($, 'route')
  await ui.select({ key: 'm:main', value: 'sonnet' })
  await route($, 'off')
  await ui.press({ key: 'apply' })
  expect(await ui.find({ type: 'Text', text: '○ off' })).toBeDefined()
  await ui.unmount()
})

test('a /route change reports success even when the status refresh fails', async ($, on) => {
  mock.store(on, { config: MINE })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => {
    throw new Error('no usage')
  })
  const sent: Sent[] = []
  on('turn.step', async function* (_$, e) {
    sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usageOf(1000) }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'a')
  expect((await route($, 'set main sonnet low')).text).toBe('main → sonnet · low.')
  await step($, 'b')
  expect(sent.map(one => one.model)).toEqual([opus, sonnet])
})

test('agents not seen at spawn are routed from the agent list, and looked up once', async ($, on) => {
  mock.store(on, { config: { ...MINE, routes: { ...MINE.routes, 'sub:Explore': { model: 'haiku', effort: 'low' }, teammate: { model: 'opus', effort: 'high' } } } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let lists = 0
  on('agent.list', () => {
    lists += 1
    return { value: [{ id: 'ex', type: 'Explore' }, { id: 'tm', type: 'general-purpose', teammateId: 't1' }, { id: 'fk', type: FORK }] } as never
  })
  const sent: Sent[] = []
  bottomStep(on, sent)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (const id of ['ex', 'ex', 'tm', 'fk']) await step($, 's', id)
  expect(sent.map(one => one.model)).toEqual([haiku, haiku, opus, sonnet])
  expect(lists).toBe(3)
})

test('slash commands that reach the model are guarded once learned or from a prompt-only source', async ($, on) => {
  const data: Record<string, unknown> = { config: MINE }
  sharedStore(on, data)
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 200_000, usage: usageOf(200_000) })
  on('command.list', () => ({ value: [{ name: 'help', description: '', source: 'builtin' }, { name: 'mcp-prompt', description: '', source: 'mcp' }, { name: 'simplify', description: '', source: 'builtin' }] }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const command = (name: string) => $.command.run({ command: name, args: '', origin: { kind: 'composer' } } as unknown as Args<'command.run'>)

  await command('simplify')
  await $.turn.start({ text: 'simplify', turnId: 'warm' })
  await step($, 'warm')
  expect(data.modelCommands).toEqual(['simplify'])
  await command('help')
  await submit($, 'a plain prompt')
  await $.turn.start({ text: 'a plain prompt', turnId: 'plain' })
  expect(data.modelCommands).toEqual(['simplify'])

  await clock.advance(61 * 60_000)
  expect((await command('help')).text).toBe('engine')
  expect((await command('simplify')).text).toMatch(/^model-router: the prompt cache went cold .* Run \/simplify again to pay it/)
  expect((await command('simplify')).text).toBe('engine')
})

test('a prompt-only command is guarded on its first cold run', async ($, on) => {
  mock.store(on, { config: MINE })
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 200_000, usage: usageOf(200_000) })
  on('command.list', () => ({ value: [{ name: 'mcp-prompt', description: '', source: 'mcp' }] }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'a')
  await clock.advance(61 * 60_000)
  const command = (kind: string) => $.command.run({ command: 'mcp-prompt', args: '', origin: { kind } } as unknown as Args<'command.run'>)
  expect((await command('task-notification')).text).toBe('engine')
  expect((await command('composer')).text).toMatch(/Run \/mcp-prompt again/)
})

test('a background agent that outlives its prompt is charged to that prompt', async ($, on) => {
  const data: Record<string, unknown> = { config: MINE }
  sharedStore(on, data)
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 1000, usage: { ...usageOf(0), input_tokens: 1_000_000 } })
  on('agent.spawn', (_$, e) => ({ model: e.model ?? opus, agentId: 'bg' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const prompt = async (text: string) => {
    await submit($, text)
    await $.turn.start({ text, turnId: text })
  }

  await prompt('start a background agent')
  await step($, 'start a background agent')
  await $.agent.spawn({ tool_use_id: 'tu', prompt: 'p', description: 'd', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: opus, background: true, fork: false } as Args<'agent.spawn'>)
  await clock.advance(60_000)
  await prompt('next')
  await step($, 'bg-1', 'bg')
  await step($, 'bg-2', 'bg')

  const [first] = data.history as Array<{ text: string; usd: number; requests: number }>
  expect([first!.text, first!.usd, first!.requests]).toEqual(['start a background agent', 12, 3])
  const last = await mountPane($, 'last')
  expect(await last.find({ type: 'Text', text: 'No requests in this prompt yet.' })).toBeDefined()
  await last.unmount()
})

test('an agent no list names is left on its model, even while a workflow spawn is pending', async ($, on) => {
  mock.store(on, { config: { ...MINE, routes: { ...MINE.routes, workflow: { model: 'haiku', effort: 'low' } } } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }) as never)
  const sent: Sent[] = []
  bottomStep(on, sent)
  on('agent.spawn', async (_$, e) => {
    await step($, 'compaction', 'engine-fork')
    return { model: e.model ?? opus, agentId: 'wf-1' }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.agent.spawn({ tool_use_id: 'tu', prompt: 'p', description: 'd', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: opus, background: false, fork: false, workflow: { runId: 'wf_1', agentIndex: 1 } } as Args<'agent.spawn'>)
  await step($, 'w', 'wf-1')
  expect(sent.map(one => [one.agentId, one.model])).toEqual([['engine-fork', sonnet], ['wf-1', haiku]])
})

const complete = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', ...(agentId ? { agentId } : {}) } as unknown as Args<'turn.complete'>)

/** Learn-mode toasts the session shows; the router's own `Route …` switch toasts are left out. */
function collectToasts(on: On): string[] {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    if (!e.text.startsWith('Route ')) toasts.push(e.text)
    return { value: undefined } as never
  })
  return toasts
}

/** A session with learn mode set as given, two prompts apart by more than the cache TTL, the second rebuilding the cache. */
async function coldPrompts($: Engine, on: On, isLearning: boolean) {
  mock.store(on, { config: { ...MINE, coldGuard: 'off', isLearning } })
  const clock = mock.clock(on, { now: T0 })
  const facts = { context: 100_000, usage: usageOf(100_000) }
  guardSession(on, facts)
  const toasts = collectToasts(on)
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const prompt = async (id: string, usage: StepUsage) => {
    facts.usage = usage
    await submit($, id)
    await $.turn.start({ text: id, turnId: id })
    await step($, id)
    await complete($, id)
  }
  await prompt('a', usageOf(100_000))
  await clock.advance(61 * 60_000)
  return { toasts, prompt, clock, facts }
}

test('learn mode: a cold rewrite toasts once per turn, lands in the pane, and the band counts it until opened', async ($, on) => {
  const { toasts, prompt } = await coldPrompts($, on, true)
  await prompt('cold', usageOf(0, 100_000))
  expect(toasts).toEqual([
    'Cache about to go cold: The prompt cache goes cold in 5m. A send before then reads the 100k tokens for $0.02; after, it re-writes them on Opus 5.5 for $0.80. Leaving for longer? /route away · /route learn',
    'Cache went cold: The cache had expired after 1h01m idle, so this send re-wrote 100k tokens on Opus 5.5 for $0.80; read warm they would have cost $0.02. · /route learn',
  ])
  const band = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await band.find({ type: 'Button', text: 'Learn ●3' })).toBeDefined()
  await band.press({ key: 'band-learn' })
  await band.unmount()
  const after = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await after.find({ type: 'Button', text: /^Learn/ })).toBeUndefined()
  await after.unmount()
  const pane = await mountPane($, 'learn')
  expect(await pane.find({ type: 'Text', text: /re-wrote 100k tokens on Opus 5\.5 for \$0\.80/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /The same tokens on Sonnet 5\.5 would cost about \$0\.40/ })).toBeDefined()
  await pane.unmount()
})

test('learn mode off: no lessons, no toast, and switching off drops pending ones', async ($, on) => {
  const { toasts, prompt, clock } = await coldPrompts($, on, false)
  await prompt('cold', usageOf(0, 100_000))
  expect(toasts).toEqual([])
  await route($, 'learn on')
  await clock.advance(61 * 60_000)
  await submit($, 'x')
  await $.turn.start({ text: 'x', turnId: 'x' })
  await step($, 'x')
  const before = toasts.length
  await route($, 'learn off')
  await complete($, 'x')
  expect(toasts.length).toBe(before)
  const pane = await mountPane($, 'learn')
  expect(await pane.find({ type: 'Text', text: /The cache had expired/ })).toBeUndefined()
  await pane.unmount()
})

test('muted learn topics are not kept, toasted or counted, and the Learn pane mutes and unmutes them', async ($, on) => {
  const { toasts, prompt } = await coldPrompts($, on, true)
  expect((await route($, 'learn mute nope')).text).toMatch(/^Usage: \/route learn mute\|unmute <topic>, topics: cold-rewrite, /)
  expect((await route($, 'learn mute cold-rewrite')).text).toBe('Learn mode stays quiet about "Cache went cold" now. /route learn unmute cold-rewrite brings it back.')
  const before = toasts.length
  await prompt('cold', usageOf(0, 100_000))
  expect(toasts.slice(before)).toEqual([expect.stringMatching(/^An expensive model did most of the work: /)])
  const band = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  expect(await band.find({ type: 'Button', text: 'Learn ●2' })).toBeDefined()
  await band.unmount()
  const pane = await mountPane($, 'learn', 'desktop')
  expect(await pane.find({ type: 'Text', text: /The cache had expired/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /would cost about/ })).toBeDefined()
  await pane.press({ key: 'mute:pricey-model' })
  expect(await pane.find({ type: 'Text', text: /would cost about/ })).toBeUndefined()
  expect(await pane.find({ type: 'Button', text: 'An expensive model did most of the work' })).toBeDefined()
  await pane.press({ key: 'unmute:cold-rewrite' })
  expect(await pane.find({ type: 'Button', text: 'Cache went cold' })).toBeUndefined()
  await pane.unmount()
  expect((await route($, 'learn unmute pricey-model')).text).toBe('Learn mode explains "An expensive model did most of the work" again.')
})

test('a muted cold-rewrite topic drops the why from the cold-send guard', async ($, on) => {
  const { clock } = await learningSession($, on, 'refuse')
  await route($, 'learn mute cold-rewrite')
  await clock.advance(61 * 60_000)
  const held = await submit($, 'recap')
  expect(held.drop).not.toMatch(/Why:/)
})

test('a subagent turn ending does not flush the main loop lessons', async ($, on) => {
  const { toasts, facts } = await coldPrompts($, on, true)
  facts.usage = usageOf(0, 100_000)
  await submit($, 'c')
  await $.turn.start({ text: 'c', turnId: 'c' })
  await step($, 'c')
  const before = toasts.length
  await complete($, 's1', 'sub-1')
  expect(toasts.length).toBe(before)
  await complete($, 'c')
  expect(toasts.length).toBe(before + 1)
})

test('/route learn opens the pane from anywhere; on and off only when typed', async ($, on) => {
  mock.store(on)
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const run = (args: string, kind: string) => $.command.run({ command: 'route', args, origin: { kind } } as unknown as Args<'command.run'>)
  expect((await run('learn', 'peer')).text).toBe('Learn pane opened.')
  expect((await run('learn on', 'peer')).text).toMatch(/only runs when you type it/)
  expect((await run('learn on', 'composer')).text).toMatch(/^Learn mode on/)
  expect((await run('learn off', 'composer')).text).toMatch(/^Learn mode off/)
})

test('a failed lessons read never saves over them', async ($, on) => {
  const kept = [{ kind: 'cold-rewrite', at: T0, repo: 'r', fact: 'kept' }]
  const data: Record<string, unknown> = { config: { ...MINE, coldGuard: 'off', isLearning: true }, lessons: kept }
  sharedStore(on, data, new Set(['lessons']))
  const clock = mock.clock(on, { now: T0 })
  const facts = { context: 100_000, usage: usageOf(100_000) }
  guardSession(on, facts)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (const [id, usage] of [['a', usageOf(100_000)], ['cold', usageOf(0, 100_000)]] as const) {
    if (id === 'cold') await clock.advance(61 * 60_000)
    facts.usage = usage
    await submit($, id)
    await $.turn.start({ text: id, turnId: id })
    await step($, id)
    await complete($, id)
  }
  expect(data.lessons).toEqual(kept)
})

test('the learn pane explains a kind until seen enough, toggles why, and offers to turn learn mode on', async ($, on) => {
  const at = (i: number) => T0 + i * 60_000
  const cold = [0, 1, 2].map(i => ({ kind: 'cold-rewrite', at: at(i), repo: 'unknown', fact: `cold ${i}` }))
  const ctx = [{ kind: 'context-high', at: at(5), repo: 'unknown', fact: 'ctx 0' }]
  mock.store(on, { config: MINE, lessons: [...cold, ...ctx] })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const pane = await mountPane($, 'learn', 'desktop')
  expect(await pane.find({ type: 'Text', text: 'Context is getting big' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Every turn sends the whole context again/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Each request re-sends the whole conversation/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /cold 2$/ })).toBeDefined()
  await pane.press({ key: 'why:cold-rewrite' })
  expect(await pane.find({ type: 'Text', text: /^Each request re-sends the whole conversation/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Learn mode is off/ })).toBeDefined()
  await pane.press({ key: 'learn-on' })
  expect(await pane.find({ type: 'Text', text: /^Learn mode is off/ })).toBeUndefined()
  await pane.unmount()
})

/** A learning session over a 200k context on the mine preset, one warm prompt in, toasts collected. */
async function learningSession($: Engine, on: On, coldGuard: 'refuse' | 'off' = 'off') {
  mock.store(on, { config: { ...MINE, coldGuard, isLearning: true } })
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 200_000, usage: usageOf(200_000) })
  const toasts = collectToasts(on)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const prompt = async (id: string, before?: () => Promise<void>) => {
    await submit($, id)
    await $.turn.start({ text: id, turnId: id })
    await before?.()
    await step($, id)
    await complete($, id)
  }
  await prompt('a')
  return { toasts, clock, prompt }
}

test('learn mode warns while idle, before the cache goes cold', async ($, on) => {
  const { toasts, clock } = await learningSession($, on)
  await clock.advance(54 * 60_000)
  expect(toasts).toEqual([])
  await clock.advance(60_000)
  expect(toasts).toEqual([
    'Cache about to go cold: The prompt cache goes cold in 5m. A send before then reads the 200k tokens for $0.04; after, it re-writes them on Opus 5.5 for $1.60. Leaving for longer? /route away · /route learn',
  ])
})

test('learn mode explains why the cold-send guard held a message', async ($, on) => {
  const { clock } = await learningSession($, on, 'refuse')
  await clock.advance(61 * 60_000)
  const held = await submit($, 'recap')
  expect(held.drop).toMatch(/Send it again to pay it, or \/clear and start from a note\.\n\nWhy: Each request re-sends the whole conversation\./)
})

test('learn mode warns that leaving plan mode will rewrite the cache too', async ($, on) => {
  const { toasts, prompt } = await learningSession($, on)
  await prompt('p', () => attach($, 'plan_mode'))
  expect(toasts).toEqual([
    'Plan mode switches rewrite the cache: Plan mode runs on Opus 5.5 high and normal work on Opus 5.5 medium, so each switch re-writes the cache: at 200k tokens, entering cost about $1.60 and leaving will cost about $1.60. Routing both the same avoids it; so does switching while the context is small. · /route learn',
  ])
  await prompt('p2', () => attach($, 'plan_mode'))
  expect(toasts.length).toBe(1)
})

test('/route away prices stepping away for this session, from anywhere', async ($, on) => {
  const { clock } = await learningSession($, on)
  await clock.advance(18 * 60_000)
  const run = (kind: string) => $.command.run({ command: 'route', args: 'away', origin: { kind } } as unknown as Args<'command.run'>)
  const away = await run('peer')
  expect(away.text).toContain('200k tokens of context on Opus 5.5, cache warm for 42m more (60-minute TTL).')
})

test('learn mode can be switched from the /route pane and the Learn pane', async ($, on) => {
  mock.store(on, { config: MINE })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('session.model', () => ({ value: opus }))
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const routes = await mountPane($, 'route', 'desktop')
  expect(await routes.find({ type: 'Text', text: /^Learn mode/ })).toBeDefined()
  expect(await routes.find({ type: 'Text', text: /explains cache misses and model costs/ })).toBeDefined()
  await routes.press({ key: 'learn-toggle' })
  expect(await routes.find({ type: 'Text', text: /explains cache misses and model costs/ })).toBeUndefined()
  await routes.unmount()
  const learn = await mountPane($, 'learn', 'desktop')
  expect(await learn.find({ type: 'Text', text: /^Learn mode is off/ })).toBeUndefined()
  await learn.press({ key: 'learn-off' })
  expect(await learn.find({ type: 'Text', text: /^Learn mode is off/ })).toBeDefined()
  await learn.unmount()
})

test('the Learn pane shows this repo first, and All tags each fact with its repo', async ($, on) => {
  const lesson = (repo: string, at: number): Lesson => ({ kind: 'cold-rewrite', at, repo, fact: `fact in ${repo}` })
  const saved: Record<string, unknown> = { config: { ...MINE, isLearning: true }, lessons: [lesson('unknown', 1), lesson('beta', 2)] }
  sharedStore(on, saved)
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const pane = await mountPane($, 'learn', 'desktop')
  expect(await pane.find({ type: 'Text', text: 'Learn · unknown' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /fact in unknown$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /fact in beta$/ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: 'unknown · ' })).toBeUndefined()
  await pane.press({ key: 'scope-all' })
  expect(await pane.find({ type: 'Text', text: 'Learn · all repos' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'beta · ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'unknown · ' })).toBeDefined()
  expect(saved.learnScope).toBe('all')
  await pane.unmount()
})

test('an earlier Learn row shows whole on press, and the earlier ones past two show on demand', async ($, on) => {
  const at = (i: number) => T0 + i * 60_000
  const lessons: Lesson[] = [0, 1, 2, 3, 4].map(i => ({ kind: 'cold-rewrite', at: at(i), repo: 'unknown', fact: `fact ${i}` }))
  mock.store(on, { config: { ...MINE, isLearning: true }, lessons })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await mountPane($, 'learn', surface)
    expect(await pane.find({ type: 'Text', text: stamp(at(4)) })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /fact 0$/ })).toBeUndefined()
    expect(await pane.find({ type: 'Button', key: `row:cold-rewrite:${at(4)}` })).toBeUndefined()
    const row = { type: 'Text', text: 'fact 3' } as const
    expect((await pane.find(row))?.props).toMatchObject({ wrap: 'truncate-end', dimColor: true })
    await pane.press({ key: `row:cold-rewrite:${at(3)}` })
    expect((await pane.find(row))?.props).toMatchObject({ wrap: 'wrap', dimColor: false })
    expect((await pane.find({ type: 'Button', key: `row:cold-rewrite:${at(3)}` }))?.text).toBe(stamp(at(3)))
    await pane.press({ key: `row:cold-rewrite:${at(3)}` })
    expect((await pane.find(row))?.props).toMatchObject({ wrap: 'truncate-end' })
    expect(await pane.find({ type: 'Button', text: 'show 2 more' })).toBeDefined()
    await pane.press({ key: 'all:cold-rewrite' })
    expect(await pane.find({ type: 'Text', text: /fact 0$/ })).toBeDefined()
    await pane.press({ key: 'all:cold-rewrite' })
    expect(await pane.find({ type: 'Text', text: 'Habits' })).toBeDefined()
    await pane.unmount()
  }
})

test('the Learn pane points to other repos when this one has no lessons', async ($, on) => {
  mock.store(on, { config: { ...MINE, isLearning: true }, lessons: [{ kind: 'cold-rewrite', at: 1, repo: 'beta', fact: 'elsewhere' }] })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const pane = await mountPane($, 'learn', 'desktop')
  expect(await pane.find({ type: 'Text', text: 'No lessons in unknown yet; 1 lesson in other repos under All.' })).toBeDefined()
  await pane.unmount()
})

test('the band counts unread lessons in the Learn pane scope', async ($, on) => {
  const lesson = (repo: string, at: number): Lesson => ({ kind: 'cold-rewrite', at, repo, fact: `fact in ${repo}`, isToasted: true })
  const saved: Record<string, unknown> = { config: { ...MINE, isLearning: true }, lessons: [lesson('unknown', 1), lesson('beta', 2), lesson('beta', 3)] }
  sharedStore(on, saved)
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  on('ui.open', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const mountBand = () => $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })
  const band = await mountBand()
  expect(await band.find({ type: 'Button', text: 'Learn ●1' })).toBeDefined()
  await band.unmount()
  const pane = await mountPane($, 'learn', 'desktop')
  await pane.press({ key: 'scope-all' })
  await pane.unmount()
  expect(saved.lessonsReadAt).toBe(3)
  saved.lessons = [...(saved.lessons as Lesson[]), lesson('beta', 4)]
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const all = await mountBand()
  expect(await all.find({ type: 'Button', text: 'Learn ●1' })).toBeDefined()
  await all.unmount()
})

const okTool = (on: On) => on('tool.call', () => ({ result: '', text: 'ok' }) as never)
const bandOf = ($: Engine) => $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'AbovePrompt', props: {} as never })

test('a commit over a big context turns the band to next /clear until the next prompt, and learn mode says why', async ($, on) => {
  okTool(on)
  const { toasts, prompt } = await learningSession($, on)
  await prompt('c', async () => {
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "done"', tool_use_id: 'tu1' } as never)
  })
  const band = await bandOf($)
  expect((await band.find({ key: 'advice' }))?.text).toBe('next /clear')
  await band.unmount()
  expect(toasts).toEqual([
    'Clear after committing: Work was committed. Each further request re-reads the 200k tokens of finished work ($0.04 warm): /clear and start the next task fresh, or /compact to carry a summary. · /route learn',
  ])
  await prompt('d')
  const after = await bandOf($)
  expect(await after.find({ key: 'advice' })).toBeUndefined()
  await after.unmount()
})

test('MCP servers and plugins are counted per repo, and long-idle ones are listed by /route unused', async ($, on) => {
  const DAY = 86_400_000
  const old = { firstSeen: T0 - 20 * DAY, sessionsSeen: 12, calls: 0 }
  const data: Record<string, unknown> = { config: { ...MINE, coldGuard: 'off' }, toolUse: { unknown: { sessions: 12, items: { 'mcp:jira': old, 'mcp:github': old } } } }
  sharedStore(on, data)
  mock.clock(on, { now: T0 })
  guardSession(on, { context: 1000, usage: usageOf(1000) })
  okTool(on)
  on('tool.list', () => ({ value: [{ name: 'mcp__jira__search', description: '', mcp: true }, { name: 'mcp__github__get', description: '', mcp: true }, { name: 'mcp__notion__authenticate', description: '', mcp: true }, { name: 'Bash', description: '', mcp: false }] }) as never)
  on('settings.read', () => ({ value: { enabledPlugins: { 'superpowers@official': true, 'hooks-only@x': true, 'off@x': false } } }) as never)
  on('command.list', () => ({ value: [{ name: 'superpowers:brainstorm', description: '', source: 'plugin', plugin: 'superpowers@official' }] }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  const unused = async () => (await $.command.run({ command: 'route', args: 'unused', origin: { kind: 'peer' } } as unknown as Args<'command.run'>)).text
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submit($, 'go')
  await $.turn.start({ text: 'go', turnId: 'go' })
  await $.tool.call({ tool: 'mcp__github__get', tool_use_id: 'tu1' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming', tool_use_id: 'tu2' } as never)
  expect(await unused()).not.toMatch(/github/)
  // The same session starting again, as after /login, keeps its unsaved calls and is counted once.
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await step($, 'go')
  await complete($, 'go')
  const repo = (data.toolUse as Record<string, { sessions: number; items: Record<string, unknown> }>).unknown!
  expect(repo.sessions).toBe(13)
  expect(repo.items).toEqual({
    'mcp:jira': { ...old, sessionsSeen: 13 },
    'mcp:github': { ...old, sessionsSeen: 13, calls: 1, lastUsed: T0 },
    'plugin:superpowers': { firstSeen: T0, sessionsSeen: 1, calls: 1, lastUsed: T0 },
  })
  expect(await unused()).toBe('Unused in unknown (13 sessions recorded):\n  › MCP servers not used in this repo: jira. Turn each off in /mcp; it stays off for this repo only.')
})

test('the Context pane names an idle MCP server in place of its size tip', async ($, on) => {
  const old = { firstSeen: T0 - 20 * 86_400_000, sessionsSeen: 12, calls: 0 }
  mock.store(on, { toolUse: { unknown: { sessions: 12, items: { 'mcp:jira': old } } } })
  mock.clock(on, { now: T0 })
  on('tool.list', () => ({ value: [{ name: 'mcp__jira__search', description: '', mcp: true }] }) as never)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 20_000,
        window: 1_000_000,
        percent: 2,
        breakdown: {
          categories: [{ name: 'Messages', tokens: 14_000, color: 'claude', isDeferred: false, kind: 'used' }],
          totalTokens: 20_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model-default',
          percentage: 2,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [{ name: 'search', serverName: 'jira', tokens: 6000 }],
          agents: [],
          isAutoCompactEnabled: false,
          apiUsage: null,
        },
      },
    } as never,
  }))
  const ui = await mountPane($, 'context')
  expect(await ui.find({ type: 'Text', text: /^MCP server jira has not been used in this repo over 12 sessions/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /MCP server jira loads/ })).toBeUndefined()
  await ui.unmount()
})

test('the Context pane advises compacting from its own breakdown, before any request', async ($, on) => {
  mock.store(on)
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        tokens: 700_000,
        window: 1_000_000,
        percent: 70,
        breakdown: {
          categories: [{ name: 'Messages', tokens: 650_000, color: 'claude', isDeferred: false, kind: 'used' }],
          totalTokens: 700_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model-default',
          percentage: 70,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 800_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
    } as never,
  }))
  const ui = await mountPane($, 'context')
  expect(await ui.find({ type: 'Text', text: /^100k tokens to auto-compact: \/compact now/ })).toBeDefined()
  await ui.unmount()
})

/** An auto-handoff session: 200k tokens on a 60m cache, two steps open, the writes and plugin prompts collected. */
async function handoffSession($: Engine, on: On, data: Record<string, unknown> = {}) {
  data.config = { ...MINE, coldGuard: 'off', autoHandoff: true, cacheTtlMinutes: 60 }
  sharedStore(on, data)
  const clock = mock.clock(on, { now: T0 })
  const usage = usageOf(200_000)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 200_000, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  okTool(on)
  mock.env(on, { HOME: '/home/me' })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('session.id', () => ({ value: 'session-1' }) as never)
  const written: string[] = []
  on('fs.write', (_$, e) => {
    written.push(e.text)
    return { value: undefined } as never
  })
  const asked: string[] = []
  on('prompt.submit', (_$, e) => {
    if (e.origin.kind === 'plugin') asked.push(e.text)
    return { text: e.text }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await submit($, 'a')
  await $.turn.start({ text: 'a', turnId: 'a' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'one', status: 'pending' }, { content: 'two', status: 'pending' }], tool_use_id: 't1' } as never)
  await step($, 'a')
  await complete($, 'a')
  const answer = ($: Engine, turnId: string, text: string) =>
    $.turn.complete({ turnId, answer: text, durationMs: 1, isAborted: false, reason: 'answer' } as unknown as Args<'turn.complete'>)
  return { clock, written, asked, answer }
}

test('auto-handoff asks once in the cache\'s last minutes and saves the reply of its own turn', async ($, on) => {
  const { clock, written, asked, answer } = await handoffSession($, on)
  await clock.advance(56 * 60_000)
  expect(asked).toEqual([])
  await clock.advance(2 * 60_000)
  expect(asked).toEqual([HANDOFF_PROMPT])
  await clock.advance(60_000)
  expect(asked).toHaveLength(1)
  await $.turn.start({ text: HANDOFF_PROMPT, turnId: 'h' })
  await answer($, 'h', '# Handoff')
  expect(written).toEqual(['# Handoff\n'])
})

test('another plugin\'s prompt running before the auto-handoff is not saved as the handoff', async ($, on) => {
  const { clock, written, asked, answer } = await handoffSession($, on)
  await clock.advance(58 * 60_000)
  expect(asked).toEqual([HANDOFF_PROMPT])
  await $.prompt.submit({ text: 'from another plugin', origin: { kind: 'plugin', name: 'other' } } as Args<'prompt.submit'>)
  await $.turn.start({ text: 'from another plugin', turnId: 'o' })
  await answer($, 'o', 'not a handoff')
  expect(written).toEqual([])
  await $.turn.start({ text: HANDOFF_PROMPT, turnId: 'h' })
  await answer($, 'h', '# Handoff')
  expect(written).toEqual(['# Handoff\n'])
})

test('a correction typed while Claude is working counts toward the corrections advice', async ($, on) => {
  const { prompt } = await learningSession($, on)
  await submit($, 'no, use the other file')
  await $.turn.start({ text: 'no, use the other file', turnId: 'b' })
  await $.prompt.submit({ text: 'still broken', turnId: 'b', origin: { kind: 'composer' } } as Args<'prompt.submit'>)
  await step($, 'b')
  await complete($, 'b')
  const band = await bandOf($)
  expect((await band.find({ key: 'advice' }))?.text).toBe('next /clear')
  await band.unmount()
  await prompt('c')
})

test('pressing a pane that is open behind another brings it to the front', async ($, on) => {
  mock.store(on)
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const calls: string[] = []
  const shown = { current: 'model-router-learn' }
  on('ui.panes', () => ({ value: ['model-router-stats', 'model-router-learn'].map(id => ({ id, title: id, isShown: id === shown.current, isFocused: false, isPlaced: true })) }) as never)
  on('ui.close', (_$, e) => {
    calls.push(`close ${e.id}`)
    return { value: undefined } as never
  })
  on('ui.open', (_$, e) => {
    calls.push(`open ${e.id}`)
    shown.current = e.id
    return { value: { isPlaced: true } } as never
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const ui = await $.ui.mount({ plugin: 'model-router', surface: 'desktop', component: 'SessionMode', props: { modes: [] } })
  await ui.press({ key: 'stats' })
  expect(calls).toEqual(['close model-router-stats', 'open model-router-stats'])
  await ui.press({ key: 'stats' })
  expect(calls).toEqual(['close model-router-stats', 'open model-router-stats', 'open model-router-stats'])
  await ui.unmount()
})

test('an auto-handoff and a Write into the folder are recorded with their titles; the newer supersedes the older', async ($, on) => {
  const data: Record<string, unknown> = {}
  const { clock, answer } = await handoffSession($, on, data)
  await clock.advance(58 * 60_000)
  await $.turn.start({ text: HANDOFF_PROMPT, turnId: 'h' })
  await answer($, 'h', '# Auto: review routes\nbody')
  const auto = Object.entries(data.handoffs as Record<string, { title?: string; status: string; repo: string }>)
  expect(auto).toHaveLength(1)
  expect(auto[0]![1]).toMatchObject({ title: 'Auto: review routes', status: 'open', repo: 'unknown' })
  await submit($, 'write one by hand')
  await $.turn.start({ text: 'write one by hand', turnId: 'w' })
  await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/handoffs/unknown/manual.md', content: '# Manual handoff\n', tool_use_id: 'tw' } as never)
  const all = data.handoffs as Record<string, { title?: string; status: string }>
  expect(all['/home/me/.claude/handoffs/unknown/manual.md']).toMatchObject({ title: 'Manual handoff', status: 'open' })
  expect(all[auto[0]![0]]!.status).toBe('superseded')
})

test('a handoff saved by another session meanwhile is kept when this one records its own', async ($, on) => {
  const data: Record<string, unknown> = {}
  await handoffSession($, on, data)
  data.handoffs = { '/home/me/.claude/handoffs/unknown/theirs.md': { repo: 'unknown', at: T0, sessionId: 'other', status: 'open' } }
  await submit($, 'write one')
  await $.turn.start({ text: 'write one', turnId: 'w' })
  await $.tool.call({ tool: 'Write', file_path: '/home/me/.claude/handoffs/unknown/mine.md', content: '# Mine\n', tool_use_id: 'tw' } as never)
  expect(Object.keys(data.handoffs as object).sort()).toEqual(['/home/me/.claude/handoffs/unknown/mine.md', '/home/me/.claude/handoffs/unknown/theirs.md'])
})

/** A session whose handoff folder lists the given files, their text the values; `listing` steers and counts what the folder does. */
async function listedSession($: Engine, on: On, files: Record<string, string>, data: Record<string, unknown> = {}) {
  data.config = { ...MINE, coldGuard: 'off' }
  sharedStore(on, data)
  const clock = mock.clock(on, { now: T0 })
  const usage = usageOf(1000)
  const listing = { current: files, isDenied: false, isMissing: false, dropsPrompts: false, lists: 0, reads: 0 }
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1000, window: 1_000_000, percent: 20 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: 'engine' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.submit', (_$, e) => (listing.dropsPrompts ? { drop: 'dropped below' } : { text: e.text }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage }
  })
  mock.env(on, { HOME: '/home/me' })
  on('session.id', () => ({ value: 'session-1' }) as never)
  on('fs.list', (_$, e) => {
    if (listing.isDenied) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    if (e.path === '/home/me/.claude/handoffs/unknown') {
      listing.lists++
      if (listing.isMissing) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { value: Object.keys(listing.current).map(name => ({ name, kind: 'file', size: 1, mtimeMs: T0 - 60_000, isLink: false })) } as never
    }
    if (e.path === '/home/me/.claude/handoffs') return { value: [{ name: 'unknown', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] } as never
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  })
  on('fs.exists', (_$, e) => ({ value: !(listing.isMissing && e.path === '/home/me/.claude/handoffs/unknown') }) as never)
  on('fs.read', (_$, e) => {
    listing.reads++
    return { value: listing.current[e.path.split('/').pop()!] ?? '' } as never
  })
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  return { listing, filled, data, clock }
}

test('the Handoffs pane lists open handoffs; Done and Not relevant fold them with a reason, Reopen brings one back', async ($, on) => {
  await listedSession($, on, { 'a.md': '# Fix the band\n', 'b.md': 'no heading' })
  const pane = await mountPane($, 'handoffs', 'desktop')
  expect(await pane.find({ type: 'Text', text: 'Fix the band' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'b.md' })).toBeDefined()
  await pane.press({ key: 'done:/home/me/.claude/handoffs/unknown/a.md' })
  await pane.press({ key: 'drop:/home/me/.claude/handoffs/unknown/b.md' })
  expect(await pane.find({ type: 'Text', text: 'Fix the band' })).toBeUndefined()
  await pane.press({ key: 'closed-toggle' })
  expect(await pane.find({ type: 'Text', text: /done$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /not relevant$/ })).toBeDefined()
  await pane.press({ key: 'reopen:/home/me/.claude/handoffs/unknown/a.md' })
  await pane.press({ key: 'closed-toggle' })
  expect(await pane.find({ type: 'Text', text: 'Fix the band' })).toBeDefined()
  await pane.unmount()
})

test('Resume fills the prompt box with the handoff path and sends nothing', async ($, on) => {
  const { filled } = await listedSession($, on, { 'a.md': '# A\n' })
  const pane = await mountPane($, 'handoffs', 'desktop')
  await pane.press({ key: 'resume:/home/me/.claude/handoffs/unknown/a.md' })
  expect(filled).toEqual(['resume from ~/.claude/handoffs/unknown/a.md'])
  await pane.unmount()
})

test('a handoff deleted from disk is forgotten on the next listing; a failed listing forgets nothing', async ($, on) => {
  const { listing, data } = await listedSession($, on, { 'a.md': '# A\n', 'b.md': '# B\n' })
  await route($, 'handoffs')
  expect(Object.keys(data.handoffs as object)).toHaveLength(2)
  listing.current = { 'b.md': '# B\n' }
  await route($, 'handoffs')
  expect(Object.keys(data.handoffs as object)).toEqual(['/home/me/.claude/handoffs/unknown/b.md'])
  listing.isDenied = true
  await route($, 'handoffs')
  expect(Object.keys(data.handoffs as object)).toEqual(['/home/me/.claude/handoffs/unknown/b.md'])
})

test('the pane says where handoffs go when there are none', async ($, on) => {
  await listedSession($, on, {})
  const pane = await mountPane($, 'handoffs')
  expect(await pane.find({ type: 'Text', text: /^No handoffs in unknown\./ })).toBeDefined()
  await pane.unmount()
})

test('sending a prompt with an open handoff\'s path marks it resumed; a prompt the cold guard holds does not', async ($, on) => {
  const { data } = await listedSession($, on, { 'a.md': '# A\n', 'b.md': '# B\n' })
  await submit($, 'resume from ~/.claude/handoffs/unknown/a.md')
  const all = data.handoffs as Record<string, { status: string }>
  expect(all['/home/me/.claude/handoffs/unknown/a.md']!.status).toBe('resumed')
  expect(all['/home/me/.claude/handoffs/unknown/b.md']!.status).toBe('open')
})

test('a held cold send resumes nothing', async ($, on) => {
  const data: Record<string, unknown> = { config: { ...MINE, coldGuard: 'refuse' } }
  sharedStore(on, data)
  const clock = mock.clock(on, { now: T0 })
  guardSession(on, { context: 200_000, usage: usageOf(200_000) })
  mock.env(on, { HOME: '/home/me' })
  on('fs.list', (_$, e) => ({ value: e.path.endsWith('/unknown') ? [{ name: 'a.md', kind: 'file', size: 1, mtimeMs: T0, isLink: false }] : [] }) as never)
  on('fs.exists', () => ({ value: true }) as never)
  on('fs.read', () => ({ value: '# A\n' }) as never)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  await submit($, 'go')
  await $.turn.start({ text: 'go', turnId: 'go' })
  await step($, 'go')
  await complete($, 'go')
  await clock.advance(61 * 60_000)
  const held = await submit($, 'resume from ~/.claude/handoffs/unknown/a.md')
  expect(held.drop).toBeDefined()
  expect((data.handoffs as Record<string, { status: string }>)['/home/me/.claude/handoffs/unknown/a.md']!.status).toBe('open')
})

test('the band shows handoffs ●N for other sessions\' open handoffs until the first prompt', async ($, on) => {
  await listedSession($, on, { 'a.md': '# A\n', 'b.md': '# B\n' })
  const band = await bandOf($)
  expect((await band.find({ key: 'band-handoffs' }))?.text).toBe('handoffs ●2')
  await band.unmount()
  await submit($, 'hello')
  const after = await bandOf($)
  expect(await after.find({ key: 'band-handoffs' })).toBeUndefined()
  await after.unmount()
})

test('a stale handoff keeps Done and Not relevant, and Reopen on an old closed one brings it back to the open list', async ($, on) => {
  const old = T0 - 20 * 86_400_000
  const data: Record<string, unknown> = {
    handoffs: {
      '/home/me/.claude/handoffs/unknown/stale.md': { repo: 'unknown', at: old, title: 'Stale one', status: 'open' },
      '/home/me/.claude/handoffs/unknown/done.md': { repo: 'unknown', at: old, title: 'Old done', status: 'done' },
    },
  }
  await listedSession($, on, { 'stale.md': '# Stale one\n', 'done.md': '# Old done\n' }, data)
  const pane = await mountPane($, 'handoffs', 'desktop')
  await pane.press({ key: 'closed-toggle' })
  expect(await pane.find({ key: 'done:/home/me/.claude/handoffs/unknown/stale.md' })).toBeDefined()
  expect(await pane.find({ key: 'drop:/home/me/.claude/handoffs/unknown/stale.md' })).toBeDefined()
  expect(await pane.find({ key: 'reopen:/home/me/.claude/handoffs/unknown/stale.md' })).toBeUndefined()
  await pane.press({ key: 'reopen:/home/me/.claude/handoffs/unknown/done.md' })
  await pane.press({ key: 'closed-toggle' })
  expect(await pane.find({ type: 'Text', text: 'Old done' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Stale one' })).toBeUndefined()
  await pane.unmount()
})

test('/route handoffs lists the folder once, and a file with no heading is read only once', async ($, on) => {
  const { listing, clock } = await listedSession($, on, { 'plain.md': 'no heading here' })
  const [lists, reads] = [listing.lists, listing.reads]
  await route($, 'handoffs')
  await clock.settle()
  expect(listing.lists - lists).toBe(1)
  await route($, 'handoffs')
  await clock.settle()
  expect(listing.reads - reads).toBe(0)
})

test('a prompt dropped further down does not resume the handoff it names', async ($, on) => {
  const { listing, data } = await listedSession($, on, { 'a.md': '# A\n' })
  listing.dropsPrompts = true
  await submit($, 'resume from ~/.claude/handoffs/unknown/a.md')
  expect((data.handoffs as Record<string, { status: string }>)['/home/me/.claude/handoffs/unknown/a.md']!.status).toBe('open')
})

test('two quick presses both stick', async ($, on) => {
  const { data, clock } = await listedSession($, on, { 'a.md': '# A\n', 'b.md': '# B\n' })
  const pane = await mountPane($, 'handoffs', 'desktop')
  await Promise.all([pane.press({ key: 'done:/home/me/.claude/handoffs/unknown/a.md' }), pane.press({ key: 'drop:/home/me/.claude/handoffs/unknown/b.md' })])
  await clock.settle()
  const all = data.handoffs as Record<string, { status: string }>
  expect([all['/home/me/.claude/handoffs/unknown/a.md']!.status, all['/home/me/.claude/handoffs/unknown/b.md']!.status]).toEqual(['done', 'dropped'])
  await pane.unmount()
})

test('a repo folder that is gone forgets its handoffs, and other repos keep theirs', async ($, on) => {
  const other = '/home/me/.claude/handoffs/other/x.md'
  const data: Record<string, unknown> = { handoffs: { [other]: { repo: 'other', at: T0, title: 'X', status: 'open' } } }
  const { listing, clock } = await listedSession($, on, { 'a.md': '# A\n' }, data)
  expect(Object.keys(data.handoffs as object).sort()).toEqual([other, '/home/me/.claude/handoffs/unknown/a.md'])
  listing.isMissing = true
  await route($, 'handoffs')
  await clock.settle()
  expect(Object.keys(data.handoffs as object)).toEqual([other])
})
