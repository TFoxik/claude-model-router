import { expect, test } from 'claude-code/testing'

import { DEV_PATIENCE, applyUsage, connectedServers, idleItems, idleReport, idleText, idleTips, itemOfCommand, itemOfToolCall, mcpKey, patienceText, pluginName, pluginOfMcpTool, pluginServer, sanitizeUsage } from './usage'
import type { UsageStore } from './usage'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-08T10:00:00Z')

test('tool calls map to the MCP server or plugin behind them', () => {
  expect(itemOfToolCall('mcp__jira__search', {})).toBe('mcp:jira')
  expect(itemOfToolCall('mcp__claude_ai_Gmail__create_draft', {})).toBe('mcp:claude_ai_Gmail')
  expect(itemOfToolCall('Skill', { skill: 'superpowers:brainstorming' })).toBe('plugin:superpowers')
  expect(itemOfToolCall('Agent', { subagent_type: 'code-simplifier:code-simplifier' })).toBe('plugin:code-simplifier')
  expect(itemOfToolCall('Task', { subagent_type: 'feature-dev:explorer' })).toBe('plugin:feature-dev')
  expect(itemOfToolCall('Skill', { skill: 'my-own-skill' })).toBeUndefined()
  expect(itemOfToolCall('Agent', { subagent_type: 'Explore' })).toBeUndefined()
  expect(itemOfToolCall('Bash', { command: 'ls' })).toBeUndefined()
  expect(itemOfCommand({ name: 'review', description: '', source: 'plugin', plugin: 'code-review@claude-plugins-official' })).toBe('plugin:code-review')
  expect(itemOfCommand({ name: 'superpowers:brainstorm', description: '', source: 'plugin' })).toBe('plugin:superpowers')
  expect(itemOfCommand({ name: 'clear', description: '', source: 'builtin' })).toBeUndefined()
  expect(mcpKey('claude.ai Gmail')).toBe('mcp:claude_ai_Gmail')
  expect(pluginName('superpowers@claude-plugins-official')).toBe('superpowers')
  expect(pluginOfMcpTool('mcp__plugin_context7_context7__resolve', ['slint', 'context7'])).toBe('plugin:context7')
  expect(pluginOfMcpTool('mcp__plugin_other_x__y', ['context7'])).toBeUndefined()
  expect(pluginOfMcpTool('mcp__jira__search', ['jira'])).toBeUndefined()
  expect(pluginServer('mcp__plugin_slint_slint-docs__search', ['slint'])).toEqual({ plugin: 'slint', server: 'slint-docs' })
  expect(pluginServer('mcp__jira__search', ['jira'])).toBeUndefined()
  expect(pluginServer('mcp__plugin_foo_bar_docs__search', ['foo', 'foo_bar'])).toEqual({ plugin: 'foo_bar', server: 'docs' })
  expect(pluginServer('mcp__plugin_foo_docs__search', ['foo', 'foo_bar'])).toEqual({ plugin: 'foo', server: 'docs' })
  expect(patienceText({ days: 14, sessions: 10 })).toBe('14 days and 10 sessions')
  expect(patienceText({ days: 0, sessions: 1 })).toBe('1 session')
})

test('usage merges into what is stored: sessions and calls add up, first seen keeps the earliest', () => {
  let store: UsageStore = {}
  store = applyUsage(store, 'app', { at: T0, isNewSession: true, seen: ['mcp:jira', 'plugin:superpowers'], used: {} })
  store = applyUsage(store, 'app', { at: T0 + DAY, isNewSession: true, seen: ['mcp:jira'], used: { 'mcp:jira': { calls: 2, lastUsed: T0 + DAY } } })
  store = applyUsage(store, 'app', { at: T0 + 2 * DAY, isNewSession: false, seen: [], used: { 'mcp:jira': { calls: 1, lastUsed: T0 + 2 * DAY }, 'mcp:new': { calls: 1, lastUsed: T0 + 2 * DAY } } })
  expect(store.app).toEqual({
    sessions: 2,
    items: {
      'mcp:jira': { firstSeen: T0, sessionsSeen: 2, calls: 3, lastUsed: T0 + 2 * DAY },
      'plugin:superpowers': { firstSeen: T0, sessionsSeen: 1, calls: 0 },
      'mcp:new': { firstSeen: T0 + 2 * DAY, sessionsSeen: 0, calls: 1, lastUsed: T0 + 2 * DAY },
    },
  })
  const backfilled = applyUsage(store, 'app', { at: T0 + DAY, isNewSession: false, seen: [], used: { 'mcp:jira': { calls: 0, lastUsed: T0 + DAY } } })
  expect(backfilled.app?.items['mcp:jira']).toEqual(store.app?.items['mcp:jira'])
})

test('stored usage keeps only well-formed entries', () => {
  const good = { sessions: 3, items: { 'mcp:jira': { firstSeen: 1, sessionsSeen: 3, calls: 0 } } }
  expect(sanitizeUsage({ app: good, bad: { sessions: 'x' }, other: { sessions: 1, items: { 'mcp:x': { firstSeen: 'no' } } } })).toEqual({ app: good, other: { sessions: 1, items: {} } })
  expect(sanitizeUsage(null)).toEqual({})
  expect(sanitizeUsage([1, 2])).toEqual({})
})

/** A repo seen for `days` over `sessions` sessions, with the given items' last use. */
const repoOf = (days: number, sessions: number, lastUsed: Record<string, number | undefined>) => ({
  sessions,
  items: Object.fromEntries(Object.entries(lastUsed).map(([key, at]) => [key, { firstSeen: T0 - days * DAY, sessionsSeen: sessions, calls: at === undefined ? 0 : 1, ...(at === undefined ? {} : { lastUsed: at }) }])),
})

test('an item is idle once loaded for two weeks and ten sessions without use in thirty days', () => {
  const store: UsageStore = {
    app: repoOf(20, 12, { 'mcp:jira': undefined, 'mcp:github': T0 - 40 * DAY, 'mcp:slack': T0 - 3 * DAY, 'plugin:superpowers': undefined }),
  }
  const loaded = ['mcp:jira', 'mcp:github', 'mcp:slack']
  expect(idleItems(store, 'app', loaded, T0)).toEqual([
    { key: 'mcp:jira', sessions: 12, isEverywhere: false },
    { key: 'mcp:github', sessions: 12, idleDays: 40, isEverywhere: false },
  ])
  expect(idleItems({ app: repoOf(10, 30, { 'mcp:jira': undefined }) }, 'app', loaded, T0)).toEqual([])
  expect(idleItems({ app: repoOf(30, 5, { 'mcp:jira': undefined }) }, 'app', loaded, T0)).toEqual([])
  expect(idleItems({}, 'app', loaded, T0)).toEqual([])
  expect(idleItems({ app: repoOf(0, 1, { 'mcp:jira': undefined, 'mcp:slack': T0 - DAY }) }, 'app', loaded, T0, { patience: DEV_PATIENCE })).toEqual([{ key: 'mcp:jira', sessions: 1, isEverywhere: false }])
})

test('idle in every repo it was seen in is told apart from idle only here', () => {
  const store: UsageStore = {
    app: repoOf(20, 12, { 'mcp:jira': undefined, 'plugin:superpowers': undefined }),
    web: repoOf(5, 2, { 'mcp:jira': undefined, 'plugin:superpowers': T0 - DAY }),
  }
  expect(idleItems(store, 'app', ['mcp:jira', 'plugin:superpowers'], T0).map(one => [one.key, one.isEverywhere])).toEqual([
    ['mcp:jira', true],
    ['plugin:superpowers', false],
  ])
})

test('a plugin listed as idle covers its own MCP server, which is not listed again', () => {
  const store: UsageStore = { app: repoOf(20, 12, { 'plugin:context7': undefined, 'mcp:plugin_context7_context7': undefined, 'mcp:jira': undefined }) }
  const owners = { 'mcp:plugin_context7_context7': 'plugin:context7' }
  const loaded = ['plugin:context7', 'mcp:plugin_context7_context7', 'mcp:jira']
  expect(idleItems(store, 'app', loaded, T0, { owners }).map(one => one.key)).toEqual(['plugin:context7', 'mcp:jira'])
  const used: UsageStore = { app: repoOf(20, 12, { 'plugin:context7': T0 - DAY, 'mcp:plugin_context7_context7': undefined }) }
  expect(idleItems(used, 'app', loaded, T0, { owners }).map(one => one.key)).toEqual(['mcp:plugin_context7_context7'])
})

test('idle tips say how to turn it off for this repo, or everywhere', () => {
  const names = { 'mcp:claude_ai_Gmail': 'claude.ai Gmail', 'plugin:superpowers': 'superpowers@official' }
  expect(idleText({ key: 'mcp:claude_ai_Gmail', sessions: 12, isEverywhere: false }, names)).toBe(
    'MCP server claude.ai Gmail has not been used in this repo over 12 sessions: turn it off in /mcp, which keeps it off for this repo only',
  )
  expect(idleText({ key: 'mcp:jira', sessions: 12, idleDays: 40, isEverywhere: true }, names)).toBe(
    'MCP server jira has not been used in 40 days here, nor in any other repo: remove it from its MCP config, or turn it off in /mcp per repo',
  )
  expect(idleText({ key: 'plugin:superpowers', sessions: 12, isEverywhere: false }, names)).toBe(
    'Plugin superpowers has not been used in this repo over 12 sessions (its hooks are not counted): "superpowers@official": false under enabledPlugins in .claude/settings.local.json turns it off for this repo only',
  )
  expect(idleText({ key: 'plugin:superpowers', sessions: 12, isEverywhere: true }, names)).toBe(
    'Plugin superpowers has not been used in this repo over 12 sessions, nor in any other repo (its hooks are not counted): disable it in /plugin',
  )
  expect(idleText({ key: 'mcp:jira', sessions: 1, isEverywhere: false }, names)).toBe(
    'MCP server jira has not been used in this repo over 1 session: turn it off in /mcp, which keeps it off for this repo only',
  )
  const tips = idleTips([{ key: 'mcp:claude_ai_Gmail', sessions: 12, isEverywhere: false }, { key: 'plugin:superpowers', sessions: 12, isEverywhere: false }], names, new Map([['claude.ai Gmail', 6000]]))
  expect(tips.map(one => [one.key, one.weight, one.replaces])).toEqual([
    ['idle:mcp:claude_ai_Gmail', 6000, 'mcp:claude.ai Gmail'],
    ['idle:plugin:superpowers', 1000, undefined],
  ])
})

test('connectors are named as /mcp names them when /context does not list them', () => {
  expect(idleText({ key: 'mcp:claude_ai_Google_Drive', sessions: 1, isEverywhere: false }, {})).toMatch(/^MCP server claude\.ai Google Drive has not/)
  expect(idleText({ key: 'mcp:claude_ai_Gmail', sessions: 1, isEverywhere: false }, { 'mcp:claude_ai_Gmail': 'claude_ai_Gmail' })).toMatch(/^MCP server claude\.ai Gmail has not/)
})

test('/route unused groups servers and plugins, each with one fix', () => {
  const names = { 'plugin:context7': 'context7@official', 'plugin:slint': 'slint@slint', 'plugin:old': 'old@x' }
  const idle = [
    { key: 'mcp:claude_ai_Gmail', sessions: 3, isEverywhere: false },
    { key: 'mcp:claude_ai_Notion', sessions: 3, isEverywhere: false },
    { key: 'mcp:jira', sessions: 3, idleDays: 40, isEverywhere: true },
    { key: 'plugin:context7', sessions: 3, isEverywhere: false },
    { key: 'plugin:slint', sessions: 3, idleDays: 31, isEverywhere: false },
    { key: 'plugin:old', sessions: 3, isEverywhere: true },
  ]
  const loaded = ['mcp:claude_ai_Gmail', 'mcp:claude_ai_Notion', 'mcp:jira', 'plugin:context7', 'plugin:slint', 'plugin:old']
  expect(idleReport(idle, names, loaded)).toEqual([
    '› MCP servers not used in this repo: claude.ai Gmail, claude.ai Notion. Turn each off in /mcp; it stays off for this repo only.',
    '› MCP servers not used in any repo: jira (40 days ago). Remove them from their MCP config, or turn them off in /mcp per repo.',
    '› None of the 2 claude.ai connectors is used here: "disableClaudeAiConnectors": true in .claude/settings.local.json turns them all off for this repo.',
    '› Plugins not used in this repo (hooks they add are not counted): context7, slint (31 days ago). To turn them off for this repo only, merge into .claude/settings.local.json:',
    '    { "enabledPlugins": { "context7@official": false, "slint@slint": false } }',
    '› Plugins not used in any repo (hooks they add are not counted): old. Disable them in /plugin.',
  ])
  expect(idleReport(idle.slice(0, 1), names, ['mcp:claude_ai_Gmail', 'mcp:claude_ai_Notion'])).toEqual([
    '› MCP servers not used in this repo: claude.ai Gmail. Turn each off in /mcp; it stays off for this repo only.',
  ])
})

test('a server offering only its sign-in tools is not connected', () => {
  expect(connectedServers([
    'mcp__claude_ai_Notion__authenticate',
    'mcp__claude_ai_Notion__complete_authentication',
    'mcp__claude_ai_Figma__get_screenshot',
    'mcp__claude_ai_Figma__authenticate',
    'mcp__jira__search',
  ])).toEqual(['mcp:claude_ai_Figma', 'mcp:jira'])
})
