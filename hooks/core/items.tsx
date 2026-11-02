import type { EngineInterface } from 'claude-code'
import { UNREADABLE, STORE, carry, load, nowOf, save } from './state'
import { session } from './session'
import { DEV_PATIENCE, PATIENCE, applyUsage, claudeAiKey, connectedServers, connectorAliases, idleItems, itemOfCommand, itemOfToolCall, mergeAliases, onlyHere, pluginKey, pluginName, pluginOfMcpTool, pluginServer, sanitizeAliases, sanitizeUsage, skillKey, sourcesOfLock, syncedSkillNames } from './usage'
import type { ItemKey, OwnSkill, Patience, UsageStore } from './usage'

type $ = EngineInterface

// Per-load memory, like `session`: a hot reload starts it over.
const memory = {
  loaded: undefined as { at: number; value: Promise<Loaded> } | undefined,
  savedUsage: undefined as { at: number; value: UsageStore } | undefined,
  // MODEL_ROUTER_IDLE_DEV=1: report idle items after one counted session instead of two weeks and ten.
  patience: PATIENCE as Patience,
}

export function startItems(idleDev: string | undefined): void {
  memory.loaded = undefined
  memory.savedUsage = undefined
  memory.patience = idleDev === '1' ? DEV_PATIENCE : PATIENCE
}

/** Every slash command, or none when the engine can't say. */
export function listCommands($: $) {
  return $.command.list().catch(() => [])
}

/**
 * `names`: what to show for a key; `owners`: the plugin key behind a plugin-shipped server's key; `commands`: the plugin or own-skill key behind a slash command;
 * `own`: your own skills and commands under ~/.claude by key, and `ownNames` the same by name;
 * `aliases`: the `claude_ai_<Name>` key of each desktop-app connector id; `synced`: claude.ai skills by every spelling a call uses, and `syncedCount` how many are loaded.
 */
export type Loaded = {
  keys: ItemKey[]
  names: Record<ItemKey, string>
  owners: Record<ItemKey, ItemKey>
  commands: Record<string, ItemKey>
  plugins: string[]
  own: Record<ItemKey, OwnSkill>
  ownNames: Set<string>
  aliases: Record<ItemKey, ItemKey>
  synced: Map<string, string>
  syncedCount: number
}

// What is loaded changes only on /mcp, /plugin or a reload, so a minute-old answer serves a pane that redraws often.
const LOADED_TTL_MS = 60_000

/** MCP servers and plugins loaded now whose use the mod can see: plugins that serve a command, a skill or an MCP server. */
async function loadedItems($: $): Promise<Loaded> {
  const now = await nowOf($)
  if (memory.loaded !== undefined && now - memory.loaded.at < LOADED_TTL_MS) return memory.loaded.value
  const value = fetchLoaded($)
  memory.loaded = { at: now, value }
  // A failed fetch is not kept: the next caller tries again.
  value.catch(() => (memory.loaded?.value === value ? (memory.loaded = undefined) : undefined))
  return value
}

/** What was last loaded, however old, for hot paths that only need the plugin list or command names. */
function cachedLoaded($: $): Promise<Loaded> {
  return memory.loaded?.value ?? loadedItems($)
}

/** Your skills (a folder or a link with a SKILL.md) and commands (`.md` files) under ~/.claude, with where the `skills` CLI installed each from. */
async function ownSkills($: $): Promise<OwnSkill[]> {
  const home = session.home ?? (await $.env.get('HOME').catch(() => undefined))
  if (home === undefined) return []
  const [skills, commands, lock] = await Promise.all([
    $.fs.list(`${home}/.claude/skills`).catch(() => []),
    $.fs.list(`${home}/.claude/commands`).catch(() => []),
    $.fs.read(`${home}/.agents/.skill-lock.json`).then(sourcesOfLock, () => ({}) as Record<string, string>),
  ])
  const found = await Promise.all(
    skills
      .filter(one => !one.name.startsWith('.') && (one.kind === 'dir' || one.isLink))
      .map(async one =>
        (await $.fs.exists(`${home}/.claude/skills/${one.name}/SKILL.md`).catch(() => false))
          ? [{ name: one.name, kind: 'skill' as const, isLink: one.isLink, ...(lock[one.name] === undefined ? {} : { source: lock[one.name] }) }]
          : [],
      ),
  )
  const files = commands
    .filter(one => !one.name.startsWith('.') && one.name.endsWith('.md') && (one.kind === 'file' || one.isLink))
    .map(one => ({ name: one.name.slice(0, -'.md'.length), kind: 'command' as const, isLink: one.isLink }))
  return [...found.flat(), ...files]
}

/**
 * Connector names: what /context shows now, over what earlier sessions saved,
 * so an id the app no longer lists still merges into its name. Saved when
 * something new turns up.
 */
function connectorNames($: $, stored: unknown, mcpTools: ReadonlyArray<{ name: string; serverName: string }>): Record<ItemKey, ItemKey> {
  const known = stored === UNREADABLE ? {} : sanitizeAliases(stored)
  const fresh = connectorAliases(mcpTools)
  const merged = { ...known, ...fresh }
  if (stored !== UNREADABLE && Object.entries(fresh).some(([id, key]) => known[id] !== key)) void save($, STORE.connectorNames, merged)
  return merged
}

async function fetchLoaded($: $): Promise<Loaded> {
  const [tools, settings, list, ownList, breakdown, storedNames] = await Promise.all([
    $.tool.list().catch(() => []),
    $.settings.read().catch(() => ({}) as Record<string, unknown>),
    listCommands($),
    ownSkills($),
    $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown).catch(() => undefined),
    load($, STORE.connectorNames),
  ])
  const aliases = connectorNames($, storedNames, breakdown?.mcpTools ?? [])
  const enabled = settings.enabledPlugins
  const ids = Object.entries(typeof enabled === 'object' && enabled !== null ? enabled : {})
    .filter(([id, isOn]) => isOn === true && pluginName(id) !== $.plugin.name)
    .map(([id]) => id)
  const plugins = ids.map(pluginName)
  const commands: Record<string, ItemKey> = {}
  for (const info of list) {
    const key = itemOfCommand(info)
    if (key !== undefined) commands[info.name] = key
  }
  const seen = new Set(Object.values(commands))
  const allMcp = tools.filter(one => one.mcp).map(one => one.name)
  const keys = new Set(connectedServers(allMcp, aliases))
  const names: Record<ItemKey, string> = {}
  const owners: Record<ItemKey, ItemKey> = {}
  for (const tool of allMcp) {
    const key = itemOfToolCall(tool, {})
    const hit = key !== undefined && keys.has(key) ? pluginServer(tool, plugins) : undefined
    if (key === undefined || hit === undefined) continue
    owners[key] = pluginKey(hit.plugin)
    names[key] = `plugin:${hit.plugin}:${hit.server}`
    seen.add(owners[key])
  }
  for (const id of ids) {
    if (!seen.has(pluginKey(id))) continue
    keys.add(pluginKey(id))
    names[pluginKey(id)] = id
  }
  const own: Record<ItemKey, OwnSkill> = {}
  for (const one of ownList) {
    const key = skillKey(one.name)
    own[key] = one
    keys.add(key)
    names[key] = one.name
    commands[one.name] ??= key
  }
  const synced = syncedSkillNames(breakdown?.skills?.skillFrontmatter ?? [])
  const listed = new Set(synced.values())
  for (const name of listed) {
    keys.add(claudeAiKey(name))
    names[claudeAiKey(name)] = name
  }
  return { keys: [...keys], names, owners, commands, plugins, own, ownNames: new Set(ownList.map(one => one.name)), aliases, synced, syncedCount: listed.size }
}

export function noteUse(key: ItemKey, at: number, calls: number) {
  const was = session.kept.used[key]
  session.kept.used[key] = { calls: (was?.calls ?? 0) + calls, lastUsed: Math.max(was?.lastUsed ?? at, at) }
}

/** The MCP server, plugin or own skill a tool use counts toward, if any. */
export async function itemsOfToolUse($: $, tool: string, input: Record<string, unknown>): Promise<ItemKey[]> {
  // Only a Skill call needs the loaded names; a connector id is merged into its name when usage is saved.
  const known = tool === 'Skill' ? await cachedLoaded($) : undefined
  const direct = itemOfToolCall(tool, input, known?.ownNames, known?.synced)
  if (direct === undefined) return []
  const owner = direct.startsWith('mcp:plugin_') ? pluginOfMcpTool(tool, (await cachedLoaded($)).plugins) : undefined
  return owner === undefined ? [direct] : [direct, owner]
}

export async function noteCommand($: $, name: string) {
  const key = (await cachedLoaded($)).commands[name]
  if (key === undefined) return
  noteUse(key, await nowOf($), 1)
  void carry($).catch(() => undefined)
}

/** Backfills a resumed transcript: its calls only move `lastUsed`, since the session that made them counted them. */
export async function backfillUsage($: $) {
  const [now, messages] = await Promise.all([nowOf($), $.session.messages().catch(() => [])])
  for (const message of messages) for (const use of message.toolUses) for (const key of await itemsOfToolUse($, use.tool, use.input)) noteUse(key, now, 0)
  await carry($)
}

/**
 * Saves what this session used, merged with what other sessions stored. A
 * session's loaded items are taken at its first save after a prompt, when
 * slow MCP servers have connected; a session with no prompt is not counted.
 */
export async function flushUsage($: $, canCount: boolean) {
  const isNewSession = canCount && session.kept.isUncounted
  if (!isNewSession && Object.keys(session.kept.used).length === 0) return
  // Taken fresh: a list cached at session start may predate the MCP servers that connect late.
  if (isNewSession) memory.loaded = undefined
  const [stored, now, loaded] = await Promise.all([load($, STORE.toolUse), nowOf($), isNewSession ? loadedItems($) : memory.loaded?.value.catch(() => undefined)])
  if (stored === UNREADABLE) return
  const used = session.kept.used
  session.kept = { ...session.kept, used: {}, isUncounted: session.kept.isUncounted && !isNewSession }
  const next = applyUsage(mergeAliases(sanitizeUsage(stored), loaded?.aliases ?? {}), session.repo, { at: now, isNewSession, seen: isNewSession ? (loaded?.keys ?? []) : [], used })
  const isSaved = await $.store.set(STORE.toolUse, next).then(() => true, () => false)
  if (isSaved) {
    memory.savedUsage = { at: now, value: next }
  } else {
    // Not saved, so not lost: the calls and the uncounted session wait for the next save.
    for (const [key, use] of Object.entries(used)) noteUse(key, use.lastUsed, use.calls)
    if (isNewSession) session.kept = { ...session.kept, isUncounted: true }
  }
  await carry($)
}

/** The usage every session has saved, re-read at most once a minute: other sessions save too, but a pane redraws far more often. */
async function savedUsage($: $): Promise<UsageStore> {
  const now = await nowOf($)
  if (memory.savedUsage !== undefined && now - memory.savedUsage.at < LOADED_TTL_MS) return memory.savedUsage.value
  const stored = await load($, STORE.toolUse)
  const value = stored === UNREADABLE ? {} : sanitizeUsage(stored)
  if (stored !== UNREADABLE) memory.savedUsage = { at: now, value }
  return value
}

/** Idle MCP servers, plugins and own skills in this repo, and own skills used only here, counting this session's calls not yet saved, with what is loaded and this repo's saved usage. */
export async function idleHere($: $) {
  const [saved, loaded, now] = await Promise.all([savedUsage($), loadedItems($), nowOf($)])
  const store = applyUsage(mergeAliases(saved, loaded.aliases), session.repo, { at: now, isNewSession: false, seen: [], used: session.kept.used })
  const idle = idleItems(store, session.repo, loaded.keys, now, { patience: memory.patience, owners: loaded.owners })
  return { idle, only: onlyHere(store, session.repo, Object.keys(loaded.own), now, memory.patience), loaded, repo: saved[session.repo], patience: memory.patience }
}
