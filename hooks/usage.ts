import type { CommandInfo } from 'claude-code'

import { plural, printable } from './routes'
import type { Tip, TipAction } from './tips'

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

/** `mcp:<server>` as tool names spell it, `plugin:<name>` without the marketplace, `skill:<name>` for one of your own skills or commands, or `claudeai:<name>` for a skill synced from claude.ai. */
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
export const skillKey = (name: string): ItemKey => `skill:${name}`
export const claudeAiKey = (name: string): ItemKey => `claudeai:${name}`
const prefixOf = (name: unknown) => (typeof name === 'string' && name.includes(':') ? name.split(':')[0] : undefined)
const baseOf = (name: string) => name.slice(name.lastIndexOf(':') + 1)

// The prefix the Skill tool puts on skills synced from claude.ai, the organization's included.
const SYNCED_PREFIX = 'anthropic-skills'

/**
 * Skills synced from claude.ai, as /context lists them (`source: syncedSkills`),
 * by every spelling a Skill call may use for them: the listed name, and its
 * bare name, which calls also reach with the claude.ai prefix.
 */
export function syncedSkillNames(skills: ReadonlyArray<{ name: string; source: string }>): Map<string, string> {
  const out = new Map<string, string>()
  for (const one of skills) {
    if (one.source !== 'syncedSkills') continue
    out.set(one.name, one.name)
    if (!out.has(baseOf(one.name))) out.set(baseOf(one.name), one.name)
  }
  return out
}

/** The listed name of the synced skill a Skill call names, if it is one: another plugin's skill of the same bare name is not. */
function syncedSkillOf(skill: string, synced: ReadonlyMap<string, string>): string | undefined {
  const exact = synced.get(skill)
  if (exact !== undefined) return exact
  const prefix = prefixOf(skill)
  return prefix === undefined || prefix === SYNCED_PREFIX ? synced.get(baseOf(skill)) : undefined
}

/**
 * The MCP server, plugin, own skill or claude.ai skill a tool call uses: an
 * `mcp__` tool, one of `userSkills`, a skill `synced` from claude.ai, or a
 * plugin's `name:` skill or agent.
 */
const NO_NAMES: ReadonlySet<string> = new Set()
const NO_SYNCED: ReadonlyMap<string, string> = new Map()

export function itemOfToolCall(tool: string, input: Record<string, unknown>, userSkills: ReadonlySet<string> = NO_NAMES, synced: ReadonlyMap<string, string> = NO_SYNCED): ItemKey | undefined {
  const mcp = /^mcp__(.+?)__/.exec(tool)
  if (mcp) return `mcp:${mcp[1]}`
  if (tool === 'Skill' && typeof input.skill === 'string' && userSkills.has(input.skill)) return skillKey(input.skill)
  const fromClaudeAi = tool === 'Skill' && typeof input.skill === 'string' ? syncedSkillOf(input.skill, synced) : undefined
  if (fromClaudeAi !== undefined) return claudeAiKey(fromClaudeAi)
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

// Servers Claude Code's own apps bring (the desktop app's panes, browser and terminal, Claude in Chrome, the IDE bridge), and claude.ai's own Visualize: nobody can turn them off, so they are never tracked.
const APP_SERVER = /^mcp:(ccd_.*|Claude_Browser|Claude_Code_iOS_Simulator|Claude_Preview|terminal|visualize|scheduled-tasks|mcp-registry|claude-in-chrome|ide|claude_ai_Visualize)$/
// claude.ai's Visualize offers exactly these; the desktop app names it by an id, so its tools tell it apart.
const VISUALIZE_TOOLS = new Set(['read_me', 'show_widget'])

// The id the desktop app gives a claude.ai connector in tool names, where the CLI spells `claude_ai_<Name>`.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CONNECTOR_ID = new RegExp(`^mcp:${UUID}$`)
const isConnectorId = (key: ItemKey) => CONNECTOR_ID.test(key)

/** A key under the name it is counted by: a desktop-app connector id under its `claude_ai_<Name>`, once that is known. */
export const aliasOf = (key: ItemKey, aliases: Readonly<Record<ItemKey, ItemKey>>): ItemKey => aliases[key] ?? key

/** Servers that are connected and yours to turn off: some tool of theirs is more than a sign-in placeholder, and no app of Claude Code's or claude.ai's brings it. */
export function connectedServers(mcpTools: readonly string[], aliases: Readonly<Record<ItemKey, ItemKey>> = {}): ItemKey[] {
  const keys = new Set<ItemKey>()
  for (const tool of mcpTools) {
    const key = SIGN_IN.test(tool) ? undefined : itemOfToolCall(tool, {})
    if (key === undefined) continue
    // A connector id whose tools are all Visualize's is claude.ai's Visualize; any other tool keeps it.
    if (isConnectorId(key) && VISUALIZE_TOOLS.has(tool.slice(tool.indexOf('__', 'mcp__'.length) + 2))) continue
    const named = aliasOf(key, aliases)
    if (!APP_SERVER.test(named)) keys.add(named)
  }
  return [...keys]
}

/**
 * The `claude_ai_<Name>` key for each desktop-app connector id /context lists
 * under an /mcp name, so a connector used from the CLI and from the desktop app
 * is counted once. An id listed under no name, or under its id, stays unnamed.
 */
export function connectorAliases(mcpTools: ReadonlyArray<{ name: string; serverName: string }>): Record<ItemKey, ItemKey> {
  const out: Record<ItemKey, ItemKey> = {}
  for (const tool of mcpTools) {
    const key = itemOfToolCall(tool.name, {})
    if (key === undefined || !isConnectorId(key)) continue
    const name = tool.serverName.trim().replace(/^claude\.ai\s+/i, '').trim()
    if (name === '' || isConnectorId(`mcp:${name}`)) continue
    out[key] = mcpKey(`claude.ai ${name}`)
  }
  return out
}

/** Stored connector names, keeping only id-to-name pairs of the right shape. */
export function sanitizeAliases(stored: unknown): Record<ItemKey, ItemKey> {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {}
  return Object.fromEntries(Object.entries(stored as Record<string, unknown>).filter((pair): pair is [string, string] => isConnectorId(pair[0]) && typeof pair[1] === 'string' && pair[1].startsWith('mcp:claude_ai_')))
}

const mergeUse = (a: ItemUse | undefined, b: ItemUse): ItemUse => {
  if (a === undefined) return b
  const lastUsed = Math.max(a.lastUsed ?? -Infinity, b.lastUsed ?? -Infinity)
  return { firstSeen: Math.min(a.firstSeen, b.firstSeen), sessionsSeen: a.sessionsSeen + b.sessionsSeen, calls: a.calls + b.calls, ...(Number.isFinite(lastUsed) ? { lastUsed } : {}) }
}

/**
 * Usage stored under a connector id moved onto its name: earliest first seen,
 * sessions and calls added up (an app's session lists one spelling only), the
 * latest use. The store comes back unchanged when no stored key has a name.
 */
export function mergeAliases(store: UsageStore, aliases: Readonly<Record<ItemKey, ItemKey>>): UsageStore {
  if (Object.keys(aliases).length === 0 || !Object.values(store).some(r => Object.keys(r.items).some(key => aliases[key] !== undefined))) return store
  const out: UsageStore = {}
  for (const [repo, r] of Object.entries(store)) {
    const items: Record<ItemKey, ItemUse> = {}
    for (const [key, use] of Object.entries(r.items)) {
      const named = aliasOf(key, aliases)
      items[named] = mergeUse(items[named], use)
    }
    out[repo] = { sessions: r.sessions, items }
  }
  return out
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
/** Loaded long enough for going unused to count. */
const isSettled = (use: ItemUse, now: number, patience: Patience) => now - use.firstSeen >= patience.days * DAY && use.sessionsSeen >= patience.sessions
/** Every other repo's usage of one item. */
const usesElsewhere = (store: UsageStore, repo: string, key: ItemKey): ItemUse[] =>
  Object.entries(store).flatMap(([name, r]) => (name === repo || r.items[key] === undefined ? [] : [r.items[key]!]))

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
    if (use === undefined || !isSettled(use, now, patience) || !isUnused(use, now)) continue
    const elsewhere = usesElsewhere(store, repo, key)
    idle.push({
      key,
      sessions: use.sessionsSeen,
      ...(use.lastUsed === undefined ? {} : { idleDays: Math.floor((now - use.lastUsed) / DAY) }),
      // A connector known only by its desktop-app id may be used from the CLI under its name, so it is never idle everywhere.
      isEverywhere: !isConnectorId(key) && elsewhere.length > 0 && elsewhere.every(one => isUnused(one, now)),
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

// How /route unused says to turn idle items off.
const FIX = {
  mcpHere: 'Turn each off in /mcp; it stays off for this repo only.',
  mcpNowhere: 'Remove them from their MCP config, or turn them off in /mcp per repo.',
  pluginHere: 'To turn them off for this repo only, merge into .claude/settings.local.json:',
  pluginNowhere: 'Disable them in /plugin.',
}
const settingOf = (keys: readonly ItemKey[], names: Readonly<Record<ItemKey, string>>) => keys.map(key => `"${nameOf(key, names)}": false`).join(', ')

/** What to call an idle item in the pane: a server as /mcp names it, a plugin by its name. */
export const idleName = (key: ItemKey, names: Readonly<Record<ItemKey, string>>) => (partsOf(key).kind === 'mcp' ? nameOf(key, names) : printable(partsOf(key).rest))

// Claude Code has no command that turns one MCP server off; /mcp does it per repo, and a claude.ai connector goes everywhere from claude.ai.
const MCP_HOW = {
  here: 'In /mcp, pick it and choose Disable: it stays off in this repo only.',
  connector: 'Disconnect it in claude.ai under Settings → Connectors to drop it everywhere, or disable it here in /mcp.',
  config: 'Remove it from its config (claude mcp remove), or disable it here in /mcp.',
}
// A claude.ai connector, by the name tool calls spell: claude_ai_<Name>, or the bare id the desktop app gives it.
const isConnectorKey = (key: ItemKey) => isConnector(key) || isConnectorId(key)

/** Why an idle item is listed, in one line under its name: what it is, where and for how long it went unused, and for a server how to turn it off. */
export function idleText(item: IdleItem, tokens?: number): string {
  const isMcp = partsOf(item.key).kind === 'mcp'
  const how = item.idleDays === undefined ? `not used in this repo over ${plural(item.sessions, 'session')}` : `not used in this repo for ${plural(item.idleDays, 'day')}`
  const also = item.isEverywhere ? ', nor in any other repo' : ''
  const line = `${isMcp ? 'MCP server' : 'plugin'} · ${how}${also}${tokens === undefined ? '' : ` · ~${tokens} tokens a session`}`
  if (!isMcp) return line
  return `${line}. ${!item.isEverywhere ? MCP_HOW.here : isConnectorKey(item.key) ? MCP_HOW.connector : MCP_HOW.config}`
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
  if (here.length > 0) bullet(`MCP servers not used in this repo: ${serverList(here)}. ${FIX.mcpHere}`)
  if (nowhere.length > 0) bullet(`MCP servers not used in any repo: ${serverList(nowhere)}. ${FIX.mcpNowhere}`)
  if (connectors.length > 1 && connectors.every(key => servers.some(one => one.key === key))) {
    bullet(`None of the ${connectors.length} claude.ai connectors is used here: "disableClaudeAiConnectors": true in .claude/settings.local.json turns them all off for this repo.`)
  }
  if (local.length > 0) {
    bullet(`Plugins not used in this repo (hooks they add are not counted): ${pluginList(local)}. ${FIX.pluginHere}`)
    lines.push(`    { "enabledPlugins": { ${settingOf(local.map(one => one.key), names)} } }`)
  }
  if (unused.length > 0) bullet(`Plugins not used in any repo (hooks they add are not counted): ${pluginList(unused)}. ${FIX.pluginNowhere}`)
  return lines
}

const OPEN_MCP = { label: 'Open /mcp', command: 'mcp', isSlash: true }

/**
 * Idle MCP servers and plugins as Context-pane tips, weighed by the tool
 * schemas they load where /context knows it; an idle server's tip replaces
 * its size tip.
 */
export function idleTips(
  items: readonly IdleItem[],
  names: Readonly<Record<ItemKey, string>>,
  mcpTokens: ReadonlyMap<string, number>,
  { root, tokens = new Map() }: { root?: string; tokens?: ReadonlyMap<ItemKey, number> } = {},
): Tip[] {
  const servers = new Map<ItemKey, { server: string; tokens: number }>()
  for (const [server, size] of mcpTokens) servers.set(mcpKey(server), { server, tokens: size })
  return items
    .filter(one => partsOf(one.key).kind === 'mcp' || partsOf(one.key).kind === 'plugin')
    .map(one => {
      const loaded = servers.get(one.key)
      const kind = partsOf(one.key).kind
      // /mcp is interactive: the button opens it rather than running a fix.
      const action = kind === 'plugin' ? pluginFix(names[one.key] ?? '', one.isEverywhere, root) : OPEN_MCP
      // A server's /context size counts its deferred tools too, which are not sent, so only a plugin's listing tokens are shown.
      const listed = kind === 'plugin' ? tokens.get(one.key) : undefined
      return {
        key: `idle:${one.key}`,
        weight: loaded?.tokens ?? tokens.get(one.key) ?? UNKNOWN_WEIGHT,
        title: idleName(one.key, names),
        text: idleText(one, listed),
        ...(loaded ? { replaces: `mcp:${loaded.server}` } : {}),
        ...(action ? { action } : {}),
      }
    })
}

/** A skill or command under ~/.claude, whether it is a link to files kept elsewhere, and the repo the `skills` CLI installed it from, when it did. */
export type OwnSkill = { name: string; kind: 'skill' | 'command'; isLink: boolean; source?: string }

/** Skill names and the repo each was installed from, from the `skills` CLI's ~/.agents/.skill-lock.json; nothing when it is not that file. */
export function sourcesOfLock(text: string): Record<string, string> {
  let lock: unknown
  try {
    lock = JSON.parse(text)
  } catch {
    return {}
  }
  const skills = (lock as { skills?: unknown } | null)?.skills
  if (typeof skills !== 'object' || skills === null) return {}
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(skills)) {
    const source = (entry as { source?: unknown } | null)?.source
    if (typeof source === 'string') out[name] = source
  }
  return out
}
export type Fix = TipAction

// What may go into a command a button puts in the prompt: names and paths come from disk, and the person runs it with one Enter.
const SAFE_NAME = /^[A-Za-z0-9._@:-]+$/
const SAFE_ROOT = /^\/[A-Za-z0-9 ._/@+-]*$/
const isSafeName = (name: string) => SAFE_NAME.test(name) && !name.startsWith('-')
// Below this many other settled repos, "only used here" is a guess.
const ONLY_HERE_OTHERS = 2
// Weight of an own skill whose listing size /context does not give: about one skill's line.
const SKILL_WEIGHT = 60

const inRoot = (root: string | undefined, command: string) => (root === undefined ? command : `cd "${root}" && ${command}`)

/** `claude plugin disable` for this repo only (local scope, run from its root) or everywhere. */
export function pluginFix(id: string, isEverywhere: boolean, root?: string): Fix | undefined {
  if (!id.includes('@') || !isSafeName(id) || (root !== undefined && !SAFE_ROOT.test(root))) return undefined
  if (isEverywhere) return { label: 'Disable everywhere', command: `! claude plugin disable ${id} --scope user` }
  if (root === undefined) return undefined
  return { label: 'Disable here', command: `! ${inRoot(root, `claude plugin disable ${id} --scope local`)}` }
}

/** Moves own skills and commands into archive folders beside them, where a move back restores them; a relative link keeps its depth, so it still resolves. */
export function archiveFix(skills: readonly OwnSkill[]): Fix | undefined {
  if (skills.length === 0 || !skills.every(one => isSafeName(one.name))) return undefined
  const dirs = skills.filter(one => one.kind === 'skill').map(one => `~/.claude/skills/${one.name}`)
  const files = skills.filter(one => one.kind === 'command').map(one => `~/.claude/commands/${one.name}.md`)
  const steps = [
    ...(dirs.length > 0 ? [`mkdir -p ~/.claude/skills-archive && mv ${dirs.join(' ')} ~/.claude/skills-archive/`] : []),
    ...(files.length > 0 ? [`mkdir -p ~/.claude/commands-archive && mv ${files.join(' ')} ~/.claude/commands-archive/`] : []),
  ]
  return { label: skills.length === 1 ? 'Archive' : `Archive ${skills.length}`, command: `! ${steps.join(' && ')}` }
}

/** Makes an own skill or command a project one in `root`; a link is re-made to its resolved target, since a relative one would break in its new folder. */
export function moveFix(skill: OwnSkill, root: string): Fix | undefined {
  if (!isSafeName(skill.name) || !SAFE_ROOT.test(root)) return undefined
  const into = `"${root}/.claude/${skill.kind === 'skill' ? 'skills' : 'commands'}"`
  const from = skill.kind === 'skill' ? `~/.claude/skills/${skill.name}` : `~/.claude/commands/${skill.name}.md`
  const to = `${into}/${skill.kind === 'skill' ? skill.name : `${skill.name}.md`}`
  const place = skill.isLink ? `ln -s "$(readlink -f ${from})" ${to} && rm ${from}` : `mv ${from} ${to}`
  return { label: 'Move here', command: `! mkdir -p ${into} && ${place}` }
}

/**
 * Own skills used in this repo and in no other: at least two other repos
 * have had them long enough and never called them.
 */
export function onlyHere(store: UsageStore, repo: string, keys: readonly ItemKey[], now: number, patience: Patience = PATIENCE): ItemKey[] {
  const here = store[repo]
  if (here === undefined) return []
  return keys.filter(key => {
    if ((here.items[key]?.calls ?? 0) === 0) return false
    const others = usesElsewhere(store, repo, key)
    const settled = others.filter(one => isSettled(one, now, patience))
    return settled.length >= ONLY_HERE_OTHERS && others.every(one => one.calls === 0)
  })
}

/** Own skills no repo uses. */
const unusedOwn = (idle: readonly IdleItem[], own: Readonly<Record<ItemKey, OwnSkill>>) =>
  idle.flatMap(one => (one.isEverywhere && own[one.key] !== undefined ? [{ key: one.key, skill: own[one.key]! }] : []))

const skillWord = (one: OwnSkill) => (one.kind === 'skill' ? 'skill' : 'command')
const labelOf = (one: OwnSkill) => (one.source === undefined ? printable(one.name) : `${printable(one.name)} (from ${printable(one.source)})`)
// The skills CLI links an installed skill into other agents too; archiving moves only Claude Code's link.
const INSTALLED_NOTE = '; installed ones stay in ~/.agents/skills for other agents'

/**
 * Own skills as Context-pane tips: the ones no repo uses as one tip whose
 * button archives them all, and each one used only here as its own tip.
 * A skill idle here but used elsewhere gets none: it cannot be turned off
 * for one repo.
 */
export function skillTips(idle: readonly IdleItem[], only: readonly ItemKey[], own: Readonly<Record<ItemKey, OwnSkill>>, root: string | undefined, tokens: ReadonlyMap<ItemKey, number> = new Map()): Tip[] {
  const weightOf = (key: ItemKey) => tokens.get(key) ?? SKILL_WEIGHT
  const tips: Tip[] = []
  const unused = unusedOwn(idle, own)
  if (unused.length > 0) {
    const total = unused.reduce((sum, one) => sum + (tokens.get(one.key) ?? 0), 0)
    const installed = [...new Set(unused.flatMap(one => (one.skill.source === undefined ? [] : [one.skill.source])))]
    const from = installed.length === 0 ? '' : ` (${installed.map(source => `${unused.filter(one => one.skill.source === source).length} from ${printable(source)}`).join(', ')}; they stay in ~/.agents/skills for other agents)`
    const action = archiveFix(unused.map(one => one.skill))
    tips.push({
      key: 'idle:own-skills',
      weight: unused.reduce((sum, one) => sum + weightOf(one.key), 0),
      title: unused.length === 1 ? printable(unused[0]!.skill.name) : `${unused.length} skills and commands`,
      text: `${unused.length === 1 ? skillWord(unused[0]!.skill) : unused.map(one => printable(one.skill.name)).join(', ')} · not used in any repo for ${IDLE_DAYS} days${total > 0 ? ` · ~${total} tokens a session` : ''}${from}. Archive moves them to ~/.claude/skills-archive; moving back restores`,
      ...(action ? { action } : {}),
    })
  }
  for (const key of only) {
    const skill = own[key]
    if (skill === undefined) continue
    const action = root === undefined ? undefined : moveFix(skill, root)
    const cost = tokens.get(key)
    tips.push({
      key: `only:${key}`,
      weight: weightOf(key),
      title: printable(skill.name),
      text: `${skillWord(skill)}${skill.source === undefined ? '' : ` from ${printable(skill.source)}`} · used only in this repo${cost === undefined ? '' : ` · ~${cost} tokens a session elsewhere`}. Move it here and other repos stop loading it`,
      ...(action ? { action } : {}),
    })
  }
  return tips
}

/** `/route unused` lines for own skills: the archive command for those no repo uses, and the move for each used only here. */
export function skillReport(idle: readonly IdleItem[], only: readonly ItemKey[], own: Readonly<Record<ItemKey, OwnSkill>>, root: string | undefined): string[] {
  const lines: string[] = []
  const unused = unusedOwn(idle, own).map(one => one.skill)
  if (unused.length > 0) {
    const note = unused.some(one => one.source !== undefined) ? INSTALLED_NOTE : ''
    lines.push(`› Skills and commands not used in any repo: ${unused.map(labelOf).join(', ')}. Archive them (moving back restores${note}):`)
    const fix = archiveFix(unused)
    if (fix) lines.push(`    ${fix.command}`)
  }
  for (const key of only) {
    const skill = own[key]
    if (skill === undefined) continue
    lines.push(`› ${labelOf(skill)} is only used in this repo. Make it a project ${skillWord(skill)} here:`)
    const fix = root === undefined ? undefined : moveFix(skill, root)
    if (fix) lines.push(`    ${fix.command}`)
  }
  return lines
}

/** Listing tokens per item from /context's skills: a plugin's skills summed, each own skill and each claude.ai skill alone. */
export function listingTokens(skills: ReadonlyArray<{ name: string; source: string; pluginName?: string; tokens: number }>): Map<ItemKey, number> {
  const tokens = new Map<ItemKey, number>()
  for (const one of skills) {
    const key = one.source === 'syncedSkills' ? claudeAiKey(one.name) : one.pluginName !== undefined ? pluginKey(one.pluginName) : one.source === 'userSettings' ? skillKey(one.name) : undefined
    if (key !== undefined) tokens.set(key, (tokens.get(key) ?? 0) + one.tokens)
  }
  return tokens
}

// Claude Code has no command that turns one claude.ai skill off: claude.ai does, and the next sync drops it here.
const CLAUDE_AI_OFF = 'Switch them off at claude.ai/customize/skills; Claude Code drops them at its next sync, within about 10 minutes'
const CLAUDE_AI_ALL = 'Or stop syncing every claude.ai skill, the ones you use too, with "syncClaudeAiSkills": false in ~/.claude/settings.json'

/** claude.ai skills no repo used in 30 days, by listed name; one used anywhere is kept, since claude.ai turns a skill off everywhere at once. */
const idleClaudeAi = (idle: readonly IdleItem[]) => idle.filter(one => one.isEverywhere && partsOf(one.key).kind === 'claudeai')

/**
 * The claude.ai skills no repo uses, as one Context-pane tip. With most of
 * the synced skills idle (`synced`: how many are loaded), it also names the
 * switch that stops syncing them all. No button: the switch is on claude.ai.
 */
export function claudeAiTips(idle: readonly IdleItem[], synced: number, tokens: ReadonlyMap<ItemKey, number> = new Map()): Tip[] {
  const unused = idleClaudeAi(idle)
  if (unused.length === 0) return []
  const names = unused.map(one => printable(partsOf(one.key).rest))
  const total = unused.reduce((sum, one) => sum + (tokens.get(one.key) ?? 0), 0)
  const all = unused.length * 2 >= synced ? `. ${CLAUDE_AI_ALL}` : ''
  return [{
    key: 'idle:claude-ai-skills',
    weight: unused.reduce((sum, one) => sum + (tokens.get(one.key) ?? SKILL_WEIGHT), 0),
    title: unused.length === 1 ? names[0]! : `${unused.length} claude.ai skills`,
    text: `${unused.length === 1 ? 'claude.ai skill' : names.join(', ')} · not used in any repo for ${IDLE_DAYS} days${total > 0 ? ` · ~${total} tokens a session` : ''}. ${CLAUDE_AI_OFF}${all}`,
  }]
}

/** `/route unused` lines for claude.ai skills no repo uses. */
export function claudeAiReport(idle: readonly IdleItem[], synced: number): string[] {
  const unused = idleClaudeAi(idle)
  if (unused.length === 0) return []
  const all = unused.length * 2 >= synced ? ` ${CLAUDE_AI_ALL}.` : ''
  return [`› claude.ai skills not used in any repo: ${unused.map(one => printable(partsOf(one.key).rest)).join(', ')}. ${CLAUDE_AI_OFF}.${all}`]
}
