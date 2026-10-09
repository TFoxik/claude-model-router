import type { SessionContextBreakdown } from 'claude-code'

import type { PromptCost, PromptRecord, Rewrite } from '../types'
import { MIN_REWRITE_USD, isPricey, lessonsFromPrompt, pct } from './lessons'
import { commandStats, kTokens, money, printable, shortPath, sumUsd } from './routes'

export type Breakdown = SessionContextBreakdown
/** `weight` ranks tips within one pane: tokens in Context, dollars in Last and Stats. */
export type Tip = { key: string; text: string; weight: number }

const MEMORY_MIN = 3000
const MCP_SERVER_MIN = 5000
const SKILLS_MIN = 3000
const AGENTS_MIN = 2000
const CONVERSATION_SHARE = 0.6
const CONVERSATION_FILL = 0.5
const COMPACT_NEAR = 0.15
const MAX_TIPS = 3
const STATS_REWRITES_MIN_USD = 1
const STATS_REWRITES_SHARE = 0.1
const COMMAND_MIN_RUNS = 3
const COMMAND_RATIO = 3
const PRICEY_SPEND_MIN_USD = 5
const PRICEY_SPEND_SHARE = 0.8

const AVOID: Record<Rewrite['cause'], string> = {
  cold: 'send before it expires, or /clear before a break; /route away compares the options',
  switch: 'switch model or plan mode at the start of a task, while the context is small',
}

const top = (tips: Tip[]) => tips.sort((x, y) => y.weight - x.weight).slice(0, MAX_TIPS)

export function tokensByServer(tools: Breakdown['mcpTools']): Map<string, number> {
  const servers = new Map<string, number>()
  for (const tool of tools) servers.set(tool.serverName, (servers.get(tool.serverName) ?? 0) + tool.tokens)
  return servers
}

/** Rewrites summed by cause, costliest first. */
function byCause(rewrites: readonly Rewrite[]): Array<[Rewrite['cause'], number]> {
  const sums = new Map<Rewrite['cause'], number>()
  for (const one of rewrites) sums.set(one.cause, (sums.get(one.cause) ?? 0) + one.usd)
  return [...sums.entries()].sort((x, y) => y[1] - x[1])
}

/** What to trim in the context window, biggest first, from the /context breakdown alone. */
export function contextTips(b: Breakdown): Tip[] {
  const tips: Tip[] = []

  for (const file of b.memoryFiles) {
    if (file.tokens < MEMORY_MIN) continue
    const action = file.type === 'AutoMem' ? 'prune it with /memory' : 'move rarely needed parts into a skill or a doc Claude reads when it needs it'
    tips.push({ key: `memory:${file.path}`, weight: file.tokens, text: `${printable(shortPath(file.path))} (${printable(file.type)}) is ${kTokens(file.tokens)}, re-sent every turn: ${action}` })
  }

  for (const [name, tokens] of tokensByServer(b.mcpTools.filter(tool => tool.isLoaded !== false))) {
    if (tokens < MCP_SERVER_MIN) continue
    tips.push({ key: `mcp:${name}`, weight: tokens, text: `MCP server ${printable(name)} loads ${kTokens(tokens)} of tool schemas: disconnect it in /mcp if this repo does not use it` })
  }

  if (b.skills && b.skills.tokens >= SKILLS_MIN) {
    tips.push({ key: 'skills', weight: b.skills.tokens, text: `${b.skills.includedSkills} skills listed take ${kTokens(b.skills.tokens)}: disable plugins this repo does not use in /plugin` })
  }

  const agentTokens = b.agents.reduce((sum, one) => sum + one.tokens, 0)
  if (agentTokens >= AGENTS_MIN) {
    tips.push({ key: 'agents', weight: agentTokens, text: `${b.agents.length} custom agents describe themselves in ${kTokens(agentTokens)}: remove the ones you do not use` })
  }

  const limit = b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
  const toGo = (limit ?? Infinity) - b.totalTokens
  // The engine names no kind for the conversation row, so this matches /context's label; a rename only silences the tip.
  const messages = b.categories.find(one => one.kind === 'used' && one.name === 'Messages')?.tokens ?? 0
  if (limit !== undefined && toGo > 0 && toGo < limit * COMPACT_NEAR) {
    tips.push({ key: 'compact', weight: b.totalTokens, text: `${kTokens(toGo)} to auto-compact: /compact now, at a point you choose, rather than mid-task` })
  } else if (messages >= b.totalTokens * CONVERSATION_SHARE && b.totalTokens >= (limit ?? b.rawMaxTokens) * CONVERSATION_FILL) {
    tips.push({ key: 'conversation', weight: messages, text: `the conversation is ${kTokens(messages)} of ${kTokens(b.totalTokens)}: when this task is done, /clear, or /compact to keep a summary` })
  }

  return top(tips)
}

/** What the last prompt's spend says to change: the learn-mode lessons for it, with an action, and its cache rewrites. */
export function lastTips(p: PromptCost, ttlMinutes: number): Tip[] {
  const tips: Tip[] = lessonsFromPrompt(p, ttlMinutes).map(one => ({
    key: one.kind,
    weight: one.usd ?? 0,
    text: one.kind === 'pricey-model' ? `${one.fact} Routine edits and searches fit a cheaper route: /route` : one.fact,
  }))
  for (const [cause, usd] of byCause(p.rewrites ?? [])) {
    if (usd < MIN_REWRITE_USD) continue
    const what = cause === 'cold' ? 'The cache had gone cold, which cost' : 'Changing model or effort re-wrote the cache for'
    tips.push({ key: `rewrite:${cause}`, weight: usd, text: `${what} ${money(usd)} over a warm read: ${AVOID[cause]}` })
  }
  return top(tips)
}

/** Patterns across saved prompts: rewrites adding up, a command far pricier than a plain prompt, Opus and Fable doing nearly everything. */
export function statsTips(records: readonly PromptRecord[]): Tip[] {
  const tips: Tip[] = []
  const total = sumUsd(records)

  const rewrites = records.flatMap(r => r.rewrites ?? [])
  const rewriteUsd = sumUsd(rewrites)
  const mainCause = byCause(rewrites)[0]?.[0]
  if (mainCause !== undefined && rewriteUsd >= STATS_REWRITES_MIN_USD && rewriteUsd >= total * STATS_REWRITES_SHARE) {
    const mostly = mainCause === 'cold' ? 'mostly cold caches' : 'mostly route switches'
    tips.push({ key: 'rewrites', weight: rewriteUsd, text: `Cache rewrites cost ${money(rewriteUsd)}, ${pct(rewriteUsd / total)} of spend, ${mostly}: ${AVOID[mainCause]}` })
  }

  const commands = commandStats(records)
  const plain = commands.find(c => c.label === 'prompt')
  for (const c of commands) {
    if (plain === undefined || c === plain || c.runs < COMMAND_MIN_RUNS || c.avg < plain.avg * COMMAND_RATIO) continue
    const model = Object.entries(c.models).sort((x, y) => y[1] - x[1])[0]?.[0]
    const on = model === undefined ? '' : `, mostly on ${printable(model)}`
    tips.push({
      key: `command:${c.label}`,
      weight: c.total - c.runs * plain.avg,
      text: `${printable(c.label)} averages ${money(c.avg)} a run over ${c.runs} runs, ${Math.round(c.avg / plain.avg)}× a plain prompt${on}: give it a narrower scope, or route its subagents cheaper in /route`,
    })
  }

  let pricey = 0
  for (const r of records) for (const [model, usd] of Object.entries(r.models ?? {})) if (isPricey(model)) pricey += usd
  if (total >= PRICEY_SPEND_MIN_USD && pricey >= total * PRICEY_SPEND_SHARE) {
    tips.push({
      key: 'pricey-models',
      weight: pricey,
      text: `Opus and Fable did ${pct(pricey / total)} of ${money(total)}: /route preset balanced keeps Opus for planning and the main loop and moves subagents and searches to Sonnet and Haiku`,
    })
  }
  return top(tips)
}
