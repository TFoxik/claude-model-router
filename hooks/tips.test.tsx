import { expect, test } from 'claude-code/testing'

import type { PromptCost, PromptItem, PromptRecord } from '../types'
import { MODELS } from './routes'
import type { Breakdown } from './tips'
import { contextTips, lastTips, statsTips } from './tips'

const breakdown = (over: Partial<Breakdown> = {}): Breakdown => ({
  categories: [
    { name: 'Messages', tokens: 20_000, color: 'claude', isDeferred: false, kind: 'used' },
    { name: 'System prompt', tokens: 10_000, color: 'subtle', isDeferred: false, kind: 'used' },
  ],
  totalTokens: 30_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'model-default',
  percentage: 15,
  gridRows: [],
  model: 'claude-opus-5-5',
  memoryFiles: [],
  mcpTools: [],
  agents: [],
  autoCompactThreshold: 160_000,
  isAutoCompactEnabled: true,
  apiUsage: null,
  ...over,
}) as Breakdown

const keys = (b: Breakdown) => contextTips(b).map(one => one.key)

test('a small, lean context has no tips', () => {
  expect(contextTips(breakdown())).toEqual([])
})

test('a big memory file is named with what to do', () => {
  const tips = contextTips(breakdown({ memoryFiles: [
    { path: '/Users/x/repo/CLAUDE.md', type: 'Project', tokens: 8100 },
    { path: '/Users/x/.claude/CLAUDE.md', type: 'User', tokens: 2900 },
  ] }))
  expect(tips).toHaveLength(1)
  expect(tips[0]?.text).toBe('repo/CLAUDE.md (Project) is 8k, re-sent every turn: move rarely needed parts into a skill or a doc Claude reads when it needs it')
})

test('a big auto-memory entry points at /memory', () => {
  const tips = contextTips(breakdown({ memoryFiles: [{ path: '/Users/x/.claude/memory/MEMORY.md', type: 'AutoMem', tokens: 4000 }] }))
  expect(tips[0]?.text).toBe('memory/MEMORY.md (AutoMem) is 4k, re-sent every turn: prune it with /memory')
})

test('an MCP server counts only the tool schemas that are loaded', () => {
  const tools = (server: string, n: number, isLoaded: boolean) =>
    Array.from({ length: n }, (_, i) => ({ name: `mcp__${server}__t${i}`, serverName: server, tokens: 1000, isLoaded }))
  const tips = contextTips(breakdown({ mcpTools: [...tools('atlassian', 14, true), ...tools('figma', 40, false), ...tools('slint', 4, true)] }))
  expect(tips.map(one => one.text)).toEqual(['MCP server atlassian loads 14k of tool schemas: disconnect it in /mcp if this repo does not use it'])
})

test('a big skills listing and many custom agents get a tip each', () => {
  const tips = contextTips(breakdown({
    skills: { totalSkills: 70, includedSkills: 64, tokens: 3400, skillFrontmatter: [] } as never,
    agents: [
      { agentType: 'a', source: 'plugin', tokens: 1200 },
      { agentType: 'b', source: 'plugin', tokens: 900 },
    ],
  }))
  expect(tips.map(one => one.text)).toEqual([
    '64 skills listed take 3k: disable plugins this repo does not use in /plugin',
    '2 custom agents describe themselves in 2k: remove the ones you do not use',
  ])
})

test('at most three tips, biggest first', () => {
  const memoryFiles = [4000, 9000, 5000, 6000].map((tokens, i) => ({ path: `/r/${i}.md`, type: 'Project', tokens }))
  expect(keys(breakdown({ memoryFiles }))).toEqual(['memory:/r/1.md', 'memory:/r/3.md', 'memory:/r/2.md'])
})

const item = (over: Partial<PromptItem>): PromptItem => ({
  id: 'main', route: 'main', label: 'Main loop', model: MODELS.opus.id, requests: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, ...over,
})
const prompt = (items: PromptItem[], rewrites?: PromptCost['rewrites']): PromptCost => ({
  usd: items.reduce((sum, one) => sum + one.usd, 0), requests: items.length, items, rewrites,
})

test('a cheap, plain prompt has no tips in Last', () => {
  expect(lastTips(prompt([item({ model: MODELS.sonnet.id, output: 1000, usd: 0.01 })]), 60)).toEqual([])
})

test('Last: an expensive model doing most of the work says what Sonnet would cost', () => {
  const tips = lastTips(prompt([item({ output: 50_000, usd: 1 })]), 60)
  expect(tips.map(one => one.text)).toEqual([
    "Opus 5.5 did 100% of this prompt's $1.00. The same tokens on Sonnet 5.5 would cost about $0.50 (price only, not quality). Routine edits and searches fit a cheaper route: /route",
  ])
})

test('Last: subagents doing most of the spending name the route to move', () => {
  const tips = lastTips(prompt([
    item({ model: MODELS.sonnet.id, usd: 0.1 }),
    item({ id: 'a1', route: 'sub:Explore', label: 'Explore', model: MODELS.sonnet.id, usd: 0.3 }),
    item({ id: 'a2', route: 'sub:Explore', label: 'Explore', model: MODELS.sonnet.id, usd: 0.3 }),
  ]), 60)
  expect(tips.map(one => one.key)).toEqual(['subagents'])
})

test('Last: a cache rewrite says how to avoid the next one, by cause', () => {
  const tips = lastTips(prompt([item({ model: MODELS.sonnet.id, usd: 0.05 })], [
    { cause: 'cold', tokens: 100_000, usd: 0.78 },
    { cause: 'switch', tokens: 100_000, usd: 0.2 },
    { cause: 'switch', tokens: 10_000, usd: 0.02 },
  ]), 60)
  expect(tips.map(one => one.text)).toEqual([
    'The cache had gone cold, which cost $0.78 over a warm read: send before it expires, or /clear before a break; /route away compares the options',
    'Changing model or effort re-wrote the cache for $0.22 over a warm read: switch model or plan mode at the start of a task, while the context is small',
  ])
})

const record = (over: Partial<PromptRecord>): PromptRecord => ({ at: 0, repo: 'r', label: 'prompt', text: '', usd: 0.5, requests: 1, agents: 0, ...over })

test('Stats: nothing to say about a few cheap prompts', () => {
  expect(statsTips([record({}), record({})])).toEqual([])
})

test('Stats: rewrites adding up name their main cause', () => {
  const tips = statsTips([
    record({ usd: 2, rewrites: [{ cause: 'cold', tokens: 100_000, usd: 0.8 }] }),
    record({ usd: 2, rewrites: [{ cause: 'cold', tokens: 100_000, usd: 0.8 }, { cause: 'switch', tokens: 50_000, usd: 0.3 }] }),
  ])
  expect(tips.map(one => one.text)).toEqual([
    'Cache rewrites cost $1.90, 48% of spend, mostly cold caches: send before it expires, or /clear before a break; /route away compares the options',
  ])
})

test('Stats: a command far pricier than a plain prompt is named with its main model', () => {
  const runs = [2, 3, 2.5].map(usd => record({ label: '/code-review', usd, models: { 'Opus 5.5 high': usd * 0.8, 'Sonnet 5.5 medium': usd * 0.2 } }))
  const tips = statsTips([...runs, record({ usd: 0.5 }), record({ usd: 0.5 }), record({ label: '/once', usd: 9 })])
  expect(tips.map(one => one.text)).toEqual([
    '/code-review averages $2.50 a run over 3 runs, 5× a plain prompt, mostly on Opus 5.5 high: give it a narrower scope, or route its subagents cheaper in /route',
  ])
})

test('Stats: Opus and Fable doing nearly all the spending suggest a cheaper preset', () => {
  const tips = statsTips(Array.from({ length: 10 }, () => record({ usd: 1, models: { 'Opus 5.5 high': 0.9, 'Haiku 5.5 low': 0.1 } })))
  expect(tips.map(one => one.text)).toEqual([
    'Opus and Fable did 90% of $10.00: /route preset balanced keeps Opus for planning and the main loop and moves subagents and searches to Sonnet and Haiku',
  ])
})

test('advice to compact or clear leads the Context tips; the breakdown alone gives none', () => {
  const near = breakdown({
    categories: [{ name: 'Messages', tokens: 140_000, color: 'claude', isDeferred: false, kind: 'used' }],
    totalTokens: 150_000,
    memoryFiles: [{ path: '/r/CLAUDE.md', type: 'Project', tokens: 9000 }],
  })
  expect(keys(near)).toEqual(['memory:/r/CLAUDE.md'])
  const advice = { verdict: 'compact' as const, text: 'compact now' }
  expect(contextTips(near, { advice }).map(one => one.key)).toEqual(['advice:compact', 'memory:/r/CLAUDE.md'])
  expect(keys(near)).toEqual(contextTips(near, { advice: { verdict: 'continue', text: '' } }).map(one => one.key))
})

test('extra tips join the ranking, and drop the tips they replace', () => {
  const b = breakdown({ mcpTools: [{ name: 'search', serverName: 'claude.ai Jira', tokens: 6000, isLoaded: true }] })
  expect(keys(b)).toEqual(['mcp:claude.ai Jira'])
  const idle = { key: 'idle:mcp:claude_ai_Jira', weight: 6000, text: 'unused', replaces: 'mcp:claude.ai Jira' }
  expect(contextTips(b, { more: [idle] }).map(one => one.key)).toEqual(['idle:mcp:claude_ai_Jira'])
})

test('heavy exploration in the main context suggests a subagent next time', () => {
  const big = breakdown({ totalTokens: 100_000 })
  const tips = contextTips(big, { explored: 40_000 })
  expect(tips.map(one => one.key)).toEqual(['exploration'])
  expect(tips[0]!.text).toBe("File reads and searches put 40k tokens (40%) into the main context: next time ask for a subagent ('use a subagent to find…'). It reads in its own context, and /route set sub:Explore haiku makes it cheap.")
  expect(contextTips(big, { explored: 20_000 })).toEqual([])
  expect(contextTips(breakdown({ totalTokens: 300_000 }), { explored: 40_000 })).toEqual([])
})
