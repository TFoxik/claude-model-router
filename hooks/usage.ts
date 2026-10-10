import type { CommandInfo } from 'claude-code'

import { plural, printable } from './routes'
import type { Tip } from './tips'

const DAY = 86_400_000
const IDLE_DAYS = 30
/** How long an item must have been loaded in a repo before going unused there counts. */
export type Patience = { days: number; sessions: number }
export const PATIENCE: Patience = { days: 14, sessions: 10 }
/** For trying the detector out: one counted session is enough. */
export const DEV_PATIENCE: Patience = { days: 0, sessions: 1 }
export const patienceText = (p: Patience) => (p.days === 0 ? plural(p.sessions, 'session') : `${plural(p.days, 'day')} and ${plural(p.sessions, 'session')}`)
// Weight of an idle item whose loaded schema size is unknown: under a big memory file, over nothing.
const UNKNOWN_WEIGHT = 1000

/** `mcp:<server>` as tool names spell it, or `plugin:<name>` without the marketplace. */
export type ItemKey = string
export type ItemUse = { firstSeen: number; sessionsSeen: number; calls: number; lastUsed?: number }
export type RepoUsage = { sessions: number; items: Record<ItemKey, ItemUse> }
export type UsageStore = Record<string, RepoUsage>
/** What a session saw loaded and used since its last save. */
export type UsageDelta = { at: number; isNewSession: boolean; seen: readonly ItemKey[]; used: Record<ItemKey, { calls: number; lastUsed: number }> }
export type IdleItem = { key: ItemKey; sessions: number; idleDays?: number; isEverywhere: boolean }

/** A name as tool names spell it: what Claude Code does to `claude.ai Gmail` to make `claude_ai_Gmail`. */
const toolSpelling = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_')
export const mcpKey = (server: string): ItemKey => `mcp:${toolSpelling(server)}`
export const pluginName = (id: string) => id.split('@')[0] ?? id
export const pluginKey = (id: string): ItemKey => `plugin:${pluginName(id)}`
const prefixOf = (name: unknown) => (typeof name === 'string' && name.includes(':') ? name.split(':')[0] : undefined)

/** The MCP server or plugin a tool call uses: an `mcp__` tool, or a plugin's `name:` skill or agent. */
export function itemOfToolCall(tool: string, input: Record<string, unknown>): ItemKey | undefined {
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return `mcp:${mcp[1]}`
  const plugin = tool === 'Skill' ? prefixOf(input.skill) : tool === 'Agent' || tool === 'Task' ? prefixOf(input.subagent_type) : undefined
  return plugin ? pluginKey(plugin) : undefined
}

/** A plugin-shipped MCP server's tool (`mcp__plugin_<plugin>_<server>__…`): which of the plugins named ships it, and the server's own part. */
export function pluginServer(tool: string, plugins: readonly string[]): { plugin: string; server: string } | undefined {
  const spelled = /^mcp__plugin_(.+?)__/.exec(tool)?.[1]
  if (spelled === undefined) return undefined
  // The longest match: with plugins `foo` and `foo_bar`, `foo_bar_docs` is foo_bar's server.
  const plugin = plugins.filter(one => spelled.startsWith(`${toolSpelling(one)}_`)).sort((a, b) => b.length - a.length)[0]
  return plugin === undefined ? undefined : { plugin, server: spelled.slice(toolSpelling(plugin).length + 1) }
}

export function pluginOfMcpTool(tool: string, plugins: readonly string[]): ItemKey | undefined {
  const found = pluginServer(tool, plugins)
  return found && pluginKey(found.plugin)
}

// What a server you have not signed in to offers instead of its tools, so Claude can start the sign-in.
const SIGN_IN = /__(authenticate|complete_authentication)$/

/** Servers that are connected: some tool of theirs is more than a sign-in placeholder. */
export function connectedServers(mcpTools: readonly string[]): ItemKey[] {
  const keys = new Set<ItemKey>()
  for (const tool of mcpTools) {
    const key = SIGN_IN.test(tool) ? undefined : itemOfToolCall(tool, {})
    if (key !== undefined) keys.add(key)
  }
  return [...keys]
}

export function itemOfCommand(info: CommandInfo): ItemKey | undefined {
  if (info.source !== 'plugin') return undefined
  const plugin = info.plugin ?? prefixOf(info.name)
  return plugin ? pluginKey(plugin) : undefined
}

/** Merges one session's delta into the stored usage; a resumed session's backfill (no calls) only moves `lastUsed` forward. */
export function applyUsage(store: UsageStore, repo: string, d: UsageDelta): UsageStore {
  const was = store[repo] ?? { sessions: 0, items: {} }
  const items = { ...was.items }
  const fresh = (): ItemUse => ({ firstSeen: d.at, sessionsSeen: 0, calls: 0 })
  for (const key of d.seen) {
    const one = items[key] ?? fresh()
    items[key] = { ...one, firstSeen: Math.min(one.firstSeen, d.at), sessionsSeen: one.sessionsSeen + 1 }
  }
  for (const [key, use] of Object.entries(d.used)) {
    const one = items[key] ?? fresh()
    const lastUsed = Math.max(one.lastUsed ?? -Infinity, use.lastUsed)
    items[key] = { ...one, calls: one.calls + use.calls, lastUsed }
  }
  return { ...store, [repo]: { sessions: was.sessions + (d.isNewSession ? 1 : 0), items } }
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const isUse = (u: unknown): u is ItemUse => {
  const x = u as ItemUse | null
  return typeof x === 'object' && x !== null && isNum(x.firstSeen) && isNum(x.sessionsSeen) && isNum(x.calls) && (x.lastUsed === undefined || isNum(x.lastUsed))
}

export function sanitizeUsage(stored: unknown): UsageStore {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  const out: UsageStore = {}
  for (const [repo, r] of Object.entries(stored as Record<string, unknown>)) {
    const x = r as Partial<RepoUsage> | null
    if (typeof x !== 'object' || x === null || !isNum(x.sessions) || typeof x.items !== 'object' || x.items === null) continue
    out[repo] = { sessions: x.sessions, items: Object.fromEntries(Object.entries(x.items).filter(([, use]) => isUse(use))) }
  }
  return out
}

const isUnused = (use: ItemUse, now: number) => use.lastUsed === undefined || now - use.lastUsed > IDLE_DAYS * DAY

/**
 * Items loaded now that this repo has had long enough to use and has not,
 * and whether every other repo left them idle too. `owners` maps a
 * plugin-shipped server to its plugin: turning an idle plugin off takes its
 * server with it, so that server is not listed again.
 */
export function idleItems(
  store: UsageStore,
  repo: string,
  loaded: readonly ItemKey[],
  now: number,
  { patience = PATIENCE, owners = {} }: { patience?: Patience; owners?: Readonly<Record<ItemKey, ItemKey>> } = {},
): IdleItem[] {
  const here = store[repo]
  if (here === undefined) return []
  const idle: IdleItem[] = []
  for (const key of loaded) {
    const use = here.items[key]
    if (use === undefined || now - use.firstSeen < patience.days * DAY || use.sessionsSeen < patience.sessions || !isUnused(use, now)) continue
    const elsewhere = Object.entries(store).flatMap(([name, r]) => (name === repo || r.items[key] === undefined ? [] : [r.items[key]!]))
    idle.push({
      key,
      sessions: use.sessionsSeen,
      ...(use.lastUsed === undefined ? {} : { idleDays: Math.floor((now - use.lastUsed) / DAY) }),
      isEverywhere: elsewhere.length > 0 && elsewhere.every(one => isUnused(one, now)),
    })
  }
  const keys = new Set(idle.map(one => one.key))
  return idle.filter(one => !keys.has(owners[one.key] ?? ''))
}

const partsOf = (key: ItemKey) => {
  const [kind = '', rest = ''] = key.split(/:(.*)/)
  return { kind, rest }
}

// A claude.ai connector's tools, and /context for a deferred one, spell `claude.ai Gmail` as `claude_ai_Gmail`.
const CONNECTOR = 'claude_ai_'
const isConnector = (key: ItemKey) => key.startsWith(`mcp:${CONNECTOR}`)

/**
 * What to call an item: `names` holds a server's /mcp name or a plugin's
 * `name@marketplace` where known; a connector's spelled name is turned back
 * into the one /mcp shows.
 */
function nameOf(key: ItemKey, names: Readonly<Record<ItemKey, string>>): string {
  const name = names[key] ?? partsOf(key).rest
  return printable(name.startsWith(CONNECTOR) ? `claude.ai ${name.slice(CONNECTOR.length).replace(/_/g, ' ')}` : name)
}

// How to turn an idle item off, for one item (a tip) or several (the report).
const FIX = {
  mcpHere: (many: boolean) => (many ? 'Turn each off in /mcp; it stays off for this repo only.' : 'turn it off in /mcp, which keeps it off for this repo only'),
  mcpNowhere: (many: boolean) => (many ? 'Remove them from their MCP config, or turn them off in /mcp per repo.' : 'remove it from its MCP config, or turn it off in /mcp per repo'),
  pluginHere: (entries: string, many: boolean) =>
    many ? 'To turn them off for this repo only, merge into .claude/settings.local.json:' : `${entries} under enabledPlugins in .claude/settings.local.json turns it off for this repo only`,
  pluginNowhere: (many: boolean) => (many ? 'Disable them in /plugin.' : 'disable it in /plugin'),
}
const HOOKS = '(its hooks are not counted)'
const settingOf = (keys: readonly ItemKey[], names: Readonly<Record<ItemKey, string>>) => keys.map(key => `"${nameOf(key, names)}": false`).join(', ')

export function idleText(item: IdleItem, names: Readonly<Record<ItemKey, string>>): string {
  const { kind, rest } = partsOf(item.key)
  const how = item.idleDays === undefined ? `has not been used in this repo over ${plural(item.sessions, 'session')}` : `has not been used in ${plural(item.idleDays, 'day')} here`
  const also = item.isEverywhere ? ', nor in any other repo' : ''
  if (kind === 'mcp') return `MCP server ${nameOf(item.key, names)} ${how}${also}: ${item.isEverywhere ? FIX.mcpNowhere(false) : FIX.mcpHere(false)}`
  const fix = item.isEverywhere ? FIX.pluginNowhere(false) : FIX.pluginHere(settingOf([item.key], names), false)
  return `Plugin ${printable(rest)} ${how}${also} ${HOOKS}: ${fix}`
}

/**
 * `/route unused` as finished lines: idle MCP servers named together with
 * the one way to turn them off, the claude.ai connectors' switch when none
 * of the loaded ones is used, and a settings block to paste for the plugins.
 */
export function idleReport(items: readonly IdleItem[], names: Readonly<Record<ItemKey, string>>, loaded: readonly ItemKey[]): string[] {
  const when = (one: IdleItem) => (one.idleDays === undefined ? '' : ` (${plural(one.idleDays, 'day')} ago)`)
  const serverList = (list: readonly IdleItem[]) => list.map(one => `${nameOf(one.key, names)}${when(one)}`).join(', ')
  const pluginList = (list: readonly IdleItem[]) => list.map(one => `${printable(partsOf(one.key).rest)}${when(one)}`).join(', ')
  const servers = items.filter(one => partsOf(one.key).kind === 'mcp')
  const plugins = items.filter(one => partsOf(one.key).kind === 'plugin')
  const here = servers.filter(one => !one.isEverywhere)
  const nowhere = servers.filter(one => one.isEverywhere)
  const local = plugins.filter(one => !one.isEverywhere)
  const unused = plugins.filter(one => one.isEverywhere)
  const connectors = loaded.filter(isConnector)
  const lines: string[] = []
  const bullet = (text: string) => lines.push(`› ${text}`)
  if (here.length > 0) bullet(`MCP servers not used in this repo: ${serverList(here)}. ${FIX.mcpHere(true)}`)
  if (nowhere.length > 0) bullet(`MCP servers not used in any repo: ${serverList(nowhere)}. ${FIX.mcpNowhere(true)}`)
  if (connectors.length > 1 && connectors.every(key => servers.some(one => one.key === key))) {
    bullet(`None of the ${connectors.length} claude.ai connectors is used here: "disableClaudeAiConnectors": true in .claude/settings.local.json turns them all off for this repo.`)
  }
  if (local.length > 0) {
    bullet(`Plugins not used in this repo (hooks they add are not counted): ${pluginList(local)}. ${FIX.pluginHere('', true)}`)
    lines.push(`    { "enabledPlugins": { ${settingOf(local.map(one => one.key), names)} } }`)
  }
  if (unused.length > 0) bullet(`Plugins not used in any repo (hooks they add are not counted): ${pluginList(unused)}. ${FIX.pluginNowhere(true)}`)
  return lines
}

/**
 * Idle items as Context-pane tips, weighed by the tool schemas they load
 * where /context knows it; an idle server's tip replaces its size tip.
 */
export function idleTips(items: readonly IdleItem[], names: Readonly<Record<ItemKey, string>>, mcpTokens: ReadonlyMap<string, number>): Tip[] {
  const servers = new Map<ItemKey, { server: string; tokens: number }>()
  for (const [server, tokens] of mcpTokens) servers.set(mcpKey(server), { server, tokens })
  return items.map(one => {
    const loaded = servers.get(one.key)
    return { key: `idle:${one.key}`, weight: loaded?.tokens ?? UNKNOWN_WEIGHT, text: idleText(one, names), ...(loaded ? { replaces: `mcp:${loaded.server}` } : {}) }
  })
}
