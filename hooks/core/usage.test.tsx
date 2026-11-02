import { expect, test } from 'claude-code/testing'

import { DEV_PATIENCE, applyUsage, archiveFix, claudeAiReport, claudeAiTips, connectedServers, connectorAliases, listingTokens, mergeAliases, sanitizeAliases, sourcesOfLock, syncedSkillNames, idleItems, idleName, idleReport, idleText, idleTips, itemOfCommand, itemOfToolCall, mcpKey, moveFix, onlyHere, patienceText, pluginFix, pluginName, pluginOfMcpTool, pluginServer, sanitizeUsage, skillReport, skillTips } from './usage'
import type { OwnSkill, UsageStore } from './usage'

const DAY = 86_400_000
const T0 = Date.parse('2026-10-08T10:00:00Z')

test('tool calls map to the MCP server or plugin behind them', () => {
  expect(itemOfToolCall('mcp__jira__search', {})).toBe('mcp:jira')
  expect(itemOfToolCall('mcp__claude_ai_Gmail__create_draft', {})).toBe('mcp:claude_ai_Gmail')
  expect(itemOfToolCall('Skill', { skill: 'superpowers:brainstorming' })).toBe('plugin:superpowers')
  expect(itemOfToolCall('Agent', { subagent_type: 'code-simplifier:code-simplifier' })).toBe('plugin:code-simplifier')
  expect(itemOfToolCall('Task', { subagent_type: 'feature-dev:explorer' })).toBe('plugin:feature-dev')
  expect(itemOfToolCall('Skill', { skill: 'my-own-skill' })).toBeUndefined()
  expect(itemOfToolCall('Skill', { skill: 'my-own-skill' }, new Set(['my-own-skill']))).toBe('skill:my-own-skill')
  expect(itemOfToolCall('Skill', { skill: 'simplify' }, new Set(['my-own-skill']))).toBeUndefined()
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
  expect(idleText({ key: 'mcp:claude_ai_Gmail', sessions: 12, isEverywhere: false })).toBe(
    'MCP server · not used in this repo over 12 sessions. In /mcp, pick it and choose Disable: it stays off in this repo only.',
  )
  expect(idleText({ key: 'mcp:jira', sessions: 12, idleDays: 40, isEverywhere: true })).toBe(
    'MCP server · not used in this repo for 40 days, nor in any other repo. Remove it from its config (claude mcp remove), or disable it here in /mcp.',
  )
  expect(idleText({ key: 'mcp:claude_ai_Gmail', sessions: 12, isEverywhere: true })).toMatch(/Disconnect it in claude\.ai under Settings → Connectors/)
  // Known only by its desktop-app id, a connector may still be used from the CLI under its name: never idle everywhere.
  const id = 'mcp:7d935e81-58a3-486c-a8da-a1b52ac6a31b'
  const settled = { firstSeen: T0, sessionsSeen: 12, calls: 0 }
  const idleId = idleItems({ '/a': { sessions: 12, items: { [id]: settled } }, '/b': { sessions: 12, items: { [id]: settled } } }, '/a', [id], T0 + 40 * DAY)
  expect(idleId.map(one => [one.key, one.isEverywhere])).toEqual([[id, false]])
  expect(idleText(idleId[0]!)).toBe('MCP server · not used in this repo over 12 sessions. In /mcp, pick it and choose Disable: it stays off in this repo only.')
  expect(idleText({ key: 'plugin:superpowers', sessions: 12, isEverywhere: false }, 840)).toBe('plugin · not used in this repo over 12 sessions · ~840 tokens a session')
  expect(idleText({ key: 'mcp:jira', sessions: 1, isEverywhere: false })).toMatch(/^MCP server · not used in this repo over 1 session\. In \/mcp/)
  expect(idleName('mcp:claude_ai_Gmail', names)).toBe('claude.ai Gmail')
  expect(idleName('plugin:superpowers', names)).toBe('superpowers')
  const tips = idleTips([{ key: 'mcp:claude_ai_Gmail', sessions: 12, isEverywhere: false }, { key: 'plugin:superpowers', sessions: 12, isEverywhere: false }], names, new Map([['claude.ai Gmail', 6000]]))
  expect(tips.map(one => [one.key, one.weight, one.replaces])).toEqual([
    ['idle:mcp:claude_ai_Gmail', 6000, 'mcp:claude.ai Gmail'],
    ['idle:plugin:superpowers', 1000, undefined],
  ])
  const withRoot = idleTips([{ key: 'plugin:superpowers', sessions: 12, isEverywhere: false }, { key: 'skill:tdd', sessions: 12, isEverywhere: true }], names, new Map(), {
    root: '/Users/me/app',
    tokens: new Map([['plugin:superpowers', 840]]),
  })
  expect(withRoot.map(one => [one.key, one.weight, one.title, one.text, one.action])).toEqual([
    [
      'idle:plugin:superpowers',
      840,
      'superpowers',
      'plugin · not used in this repo over 12 sessions · ~840 tokens a session',
      { label: 'Disable here', command: '! cd "/Users/me/app" && claude plugin disable superpowers@official --scope local' },
    ],
  ])
  expect(tips[0]?.action).toEqual({ label: 'Open /mcp', command: 'mcp', isSlash: true })
})

test('fix commands carry only safe names and paths', () => {
  expect(pluginFix('superpowers@official', true)).toEqual({ label: 'Disable everywhere', command: '! claude plugin disable superpowers@official --scope user' })
  expect(pluginFix('superpowers@official', false)).toBeUndefined()
  expect(pluginFix('superpowers', true)).toBeUndefined()
  expect(pluginFix('x@y; rm -rf ~', true)).toBeUndefined()
  expect(pluginFix('-x@y', true)).toBeUndefined()
  expect(pluginFix('a@b', false, '/tmp/$(boom)')).toBeUndefined()
  const tdd: OwnSkill = { name: 'tdd', kind: 'skill', isLink: true }
  const bighuh: OwnSkill = { name: 'bighuh', kind: 'command', isLink: false }
  expect(archiveFix([tdd, bighuh])).toEqual({
    label: 'Archive 2',
    command: '! mkdir -p ~/.claude/skills-archive && mv ~/.claude/skills/tdd ~/.claude/skills-archive/ && mkdir -p ~/.claude/commands-archive && mv ~/.claude/commands/bighuh.md ~/.claude/commands-archive/',
  })
  expect(archiveFix([tdd, { name: 'x`y`', kind: 'skill', isLink: false }])).toBeUndefined()
  expect(archiveFix([])).toBeUndefined()
  expect(moveFix(tdd, '/Users/me/My App')).toEqual({
    label: 'Move here',
    command: '! mkdir -p "/Users/me/My App/.claude/skills" && ln -s "$(readlink -f ~/.claude/skills/tdd)" "/Users/me/My App/.claude/skills"/tdd && rm ~/.claude/skills/tdd',
  })
  expect(moveFix({ name: 'tdd', kind: 'skill', isLink: false }, '/r')).toEqual({ label: 'Move here', command: '! mkdir -p "/r/.claude/skills" && mv ~/.claude/skills/tdd "/r/.claude/skills"/tdd' })
  expect(moveFix(bighuh, '/r')).toEqual({ label: 'Move here', command: '! mkdir -p "/r/.claude/commands" && mv ~/.claude/commands/bighuh.md "/r/.claude/commands"/bighuh.md' })
  expect(moveFix(tdd, 'relative/path')).toBeUndefined()
  expect(moveFix(tdd, '/a"b')).toBeUndefined()
})

test('an own skill is only used here once two other settled repos never called it', () => {
  const settled = { firstSeen: T0, sessionsSeen: 10, calls: 0 }
  const store: UsageStore = {
    app: { sessions: 12, items: { 'skill:sprint': { firstSeen: T0, sessionsSeen: 12, calls: 3, lastUsed: T0 } } },
    web: { sessions: 10, items: { 'skill:sprint': settled } },
    cli: { sessions: 10, items: { 'skill:sprint': settled } },
  }
  const now = T0 + 20 * DAY
  expect(onlyHere(store, 'app', ['skill:sprint'], now)).toEqual(['skill:sprint'])
  expect(onlyHere(store, 'web', ['skill:sprint'], now)).toEqual([])
  expect(onlyHere({ app: store.app!, web: store.web! }, 'app', ['skill:sprint'], now)).toEqual([])
  expect(onlyHere({ ...store, cli: { sessions: 10, items: { 'skill:sprint': { ...settled, calls: 1, lastUsed: T0 } } } }, 'app', ['skill:sprint'], now)).toEqual([])
  expect(onlyHere({ ...store, cli: { sessions: 2, items: { 'skill:sprint': { ...settled, sessionsSeen: 2 } } } }, 'app', ['skill:sprint'], now)).toEqual([])
})

test('own skills: unused ones share one archive tip, one used only here gets a move tip', () => {
  const own: Record<string, OwnSkill> = {
    'skill:tdd': { name: 'tdd', kind: 'skill', isLink: false },
    'skill:grill-me': { name: 'grill-me', kind: 'skill', isLink: false },
    'skill:sprint': { name: 'sprint', kind: 'skill', isLink: false },
  }
  const idle = [
    { key: 'skill:tdd', sessions: 12, isEverywhere: true },
    { key: 'skill:grill-me', sessions: 12, isEverywhere: true },
    { key: 'skill:review', sessions: 12, isEverywhere: false },
  ]
  const tips = skillTips(idle, ['skill:sprint'], own, '/r', new Map([['skill:tdd', 53], ['skill:grill-me', 61]]))
  expect(tips.map(one => [one.key, one.weight, one.action?.label])).toEqual([
    ['idle:own-skills', 114, 'Archive 2'],
    ['only:skill:sprint', 60, 'Move here'],
  ])
  expect(tips.map(one => [one.title, one.text])).toEqual([
    ['2 skills and commands', 'tdd, grill-me · not used in any repo for 30 days · ~114 tokens a session. Archive moves them to ~/.claude/skills-archive; moving back restores'],
    ['sprint', 'skill · used only in this repo. Move it here and other repos stop loading it'],
  ])
  expect(skillTips([{ key: 'skill:tdd', sessions: 12, isEverywhere: true }], [], own, undefined).map(one => [one.title, one.text])).toEqual([
    ['tdd', 'skill · not used in any repo for 30 days. Archive moves them to ~/.claude/skills-archive; moving back restores'],
  ])
  expect(skillReport(idle, ['skill:sprint'], own, '/r')).toEqual([
    '› Skills and commands not used in any repo: tdd, grill-me. Archive them (moving back restores):',
    '    ! mkdir -p ~/.claude/skills-archive && mv ~/.claude/skills/tdd ~/.claude/skills/grill-me ~/.claude/skills-archive/',
    '› sprint is only used in this repo. Make it a project skill here:',
    '    ! mkdir -p "/r/.claude/skills" && mv ~/.claude/skills/sprint "/r/.claude/skills"/sprint',
  ])
})

test('connectors are named as /mcp names them when /context does not list them', () => {
  expect(idleName('mcp:claude_ai_Google_Drive', {})).toBe('claude.ai Google Drive')
  expect(idleName('mcp:claude_ai_Gmail', { 'mcp:claude_ai_Gmail': 'claude_ai_Gmail' })).toBe('claude.ai Gmail')
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

test('servers the desktop app, Chrome or the IDE bring are never tracked', () => {
  expect(connectedServers(['mcp__ccd_session__start', 'mcp__Claude_Browser__navigate', 'mcp__terminal__run', 'mcp__claude-in-chrome__computer', 'mcp__ide__getDiagnostics', 'mcp__jira__search'])).toEqual(['mcp:jira'])
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

test('a skill the skills CLI installed is named with its source, and archiving it says what stays', () => {
  expect(sourcesOfLock(JSON.stringify({ version: 3, skills: { tdd: { source: 'mattpocock/skills' }, odd: { source: 7 } } }))).toEqual({ tdd: 'mattpocock/skills' })
  expect(sourcesOfLock('not json')).toEqual({})
  expect(sourcesOfLock('null')).toEqual({})
  const own: Record<string, OwnSkill> = { 'skill:tdd': { name: 'tdd', kind: 'skill', isLink: true, source: 'mattpocock/skills' }, 'skill:mine': { name: 'mine', kind: 'skill', isLink: false } }
  expect(skillTips([{ key: 'skill:tdd', sessions: 12, isEverywhere: true }], ['skill:mine'], own, '/r').map(one => [one.title, one.text])).toEqual([
    ['tdd', 'skill · not used in any repo for 30 days (1 from mattpocock/skills; they stay in ~/.agents/skills for other agents). Archive moves them to ~/.claude/skills-archive; moving back restores'],
    ['mine', 'skill · used only in this repo. Move it here and other repos stop loading it'],
  ])
})

test('a connector the desktop app names by id is counted under its claude_ai_ name', () => {
  const tools = [
    { name: 'mcp__4905cb54-6a36-4f49-a400-65c4d5aaa6f7__use_figma', serverName: 'claude.ai Figma' },
    { name: 'mcp__1a59c906-04da-521d-bda7-7f71b9f9e01c__guide', serverName: 'Claude Docs' },
    { name: 'mcp__b8721b7e-7394-4509-889a-432ef53f1793__search', serverName: 'b8721b7e-7394-4509-889a-432ef53f1793' },
    { name: 'mcp__claude_ai_Gmail__search_threads', serverName: 'claude.ai Gmail' },
    { name: 'mcp__jira__search', serverName: 'jira' },
  ]
  const aliases = connectorAliases(tools)
  expect(aliases).toEqual({
    'mcp:4905cb54-6a36-4f49-a400-65c4d5aaa6f7': 'mcp:claude_ai_Figma',
    'mcp:1a59c906-04da-521d-bda7-7f71b9f9e01c': 'mcp:claude_ai_Claude_Docs',
  })
  expect(connectedServers(tools.map(one => one.name), aliases)).toEqual(['mcp:claude_ai_Figma', 'mcp:claude_ai_Claude_Docs', 'mcp:b8721b7e-7394-4509-889a-432ef53f1793', 'mcp:claude_ai_Gmail', 'mcp:jira'])
  expect(sanitizeAliases({ ...aliases, 'mcp:jira': 'mcp:claude_ai_X', 'mcp:4905cb54-6a36-4f49-a400-65c4d5aaa6f8': 7 })).toEqual(aliases)
  expect(sanitizeAliases(null)).toEqual({})
})

test('usage stored under a connector id merges into its name', () => {
  const id = 'mcp:4905cb54-6a36-4f49-a400-65c4d5aaa6f7'
  const store: UsageStore = {
    '/a': { sessions: 9, items: { [id]: { firstSeen: T0, sessionsSeen: 6, calls: 0 }, 'mcp:claude_ai_Figma': { firstSeen: T0 + DAY, sessionsSeen: 3, calls: 4, lastUsed: T0 + 2 * DAY } } },
    '/b': { sessions: 2, items: { [id]: { firstSeen: T0 + DAY, sessionsSeen: 2, calls: 1, lastUsed: T0 + 3 * DAY } } },
  }
  const merged = mergeAliases(store, { [id]: 'mcp:claude_ai_Figma' })
  expect(merged['/a']?.items).toEqual({ 'mcp:claude_ai_Figma': { firstSeen: T0, sessionsSeen: 9, calls: 4, lastUsed: T0 + 2 * DAY } })
  expect(merged['/b']?.items).toEqual({ 'mcp:claude_ai_Figma': { firstSeen: T0 + DAY, sessionsSeen: 2, calls: 1, lastUsed: T0 + 3 * DAY } })
  expect(mergeAliases(store, {})).toBe(store)
  // Used from the CLI under its name, the desktop app's idle id no longer makes it idle everywhere.
  const now = T0 + 20 * DAY
  expect(idleItems(store, '/a', [id], now, { patience: DEV_PATIENCE }).map(one => one.key)).toEqual([id])
  expect(idleItems(merged, '/a', ['mcp:claude_ai_Figma'], now, { patience: DEV_PATIENCE })).toEqual([])
})

test("claude.ai's own Visualize connector is never tracked, whatever the app calls it", () => {
  expect(connectedServers(['mcp__6f616b42-0ed8-571e-823f-ee4aca6b7ce9__read_me', 'mcp__6f616b42-0ed8-571e-823f-ee4aca6b7ce9__show_widget', 'mcp__claude_ai_Visualize__show_widget', 'mcp__jira__search'])).toEqual(['mcp:jira'])
})

test('claude.ai skills are counted by their listed name, however a call spells them', () => {
  const synced = syncedSkillNames([
    { name: 'anthropic-skills:docx', source: 'syncedSkills' },
    { name: 'morning', source: 'syncedSkills' },
    { name: 'superpowers:brainstorming', source: 'plugin' },
    { name: 'tdd', source: 'userSettings' },
  ])
  expect(itemOfToolCall('Skill', { skill: 'anthropic-skills:docx' }, new Set(), synced)).toBe('claudeai:anthropic-skills:docx')
  expect(itemOfToolCall('Skill', { skill: 'docx' }, new Set(), synced)).toBe('claudeai:anthropic-skills:docx')
  expect(itemOfToolCall('Skill', { skill: 'anthropic-skills:morning' }, new Set(), synced)).toBe('claudeai:morning')
  expect(itemOfToolCall('Skill', { skill: 'other-plugin:docx' }, new Set(), synced)).toBe('plugin:other-plugin')
  expect(itemOfToolCall('Skill', { skill: 'morning' }, new Set(['morning']), synced)).toBe('skill:morning')
  expect(listingTokens([{ name: 'morning', source: 'syncedSkills', tokens: 70 }, { name: 'tdd', source: 'userSettings', tokens: 50 }])).toEqual(new Map([['claudeai:morning', 70], ['skill:tdd', 50]]))
})

test('claude.ai skills no repo uses share one tip pointing to claude.ai, never a command', () => {
  const idle = [
    { key: 'claudeai:anthropic-skills:docx', sessions: 12, isEverywhere: true },
    { key: 'claudeai:morning', sessions: 12, isEverywhere: true },
    { key: 'claudeai:pdf', sessions: 12, isEverywhere: false },
    { key: 'mcp:jira', sessions: 12, isEverywhere: true },
  ]
  const tokens = new Map([['claudeai:anthropic-skills:docx', 69], ['claudeai:morning', 70]])
  const many = claudeAiTips(idle, 4, tokens)
  expect(many.map(one => [one.key, one.weight, one.title, one.action])).toEqual([['idle:claude-ai-skills', 139, '2 claude.ai skills', undefined]])
  expect(many[0]?.text).toBe(
    'anthropic-skills:docx, morning · not used in any repo for 30 days · ~139 tokens a session. Switch them off at claude.ai/customize/skills; Claude Code drops them at its next sync, within about 10 minutes. Or stop syncing every claude.ai skill, the ones you use too, with "syncClaudeAiSkills": false in ~/.claude/settings.json',
  )
  expect(claudeAiTips(idle, 10, tokens)[0]?.text).not.toMatch(/syncClaudeAiSkills/)
  expect(claudeAiTips(idle.slice(2), 4)).toEqual([])
  expect(idleTips(idle, {}, new Map()).map(one => one.key)).toEqual(['idle:mcp:jira'])
  expect(claudeAiReport(idle, 10)).toEqual([
    '› claude.ai skills not used in any repo: anthropic-skills:docx, morning. Switch them off at claude.ai/customize/skills; Claude Code drops them at its next sync, within about 10 minutes.',
  ])
})
