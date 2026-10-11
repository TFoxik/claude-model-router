export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type RouteModel = ModelKey | 'inherit'
export type RouteEffort = Effort | 'auto' | 'inherit'
export type RouteSetting = { model: RouteModel; effort: RouteEffort }
export type RouterConfig = {
  isEnabled: boolean
  preset: string
  routes: Record<string, RouteSetting>
  cacheTtlMinutes: number
  coldGuard: ColdGuard
  keepPromptText: boolean
  isLearning: boolean
  learnMuted: LessonKind[]
  autoHandoff: boolean
  /** The band's next /clear, /compact or /handoff and the Context pane's advice tip. */
  showNext: boolean
}
export type ColdGuard = 'refuse' | 'warn' | 'off'
export type Scope = 'repo' | 'all'
export type Rewrite = { cause: 'cold' | 'switch'; tokens: number; usd: number }
export type RouteSpend = {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  usd: number
}
export type LastUsage = { model: string; input: number; cacheRead: number; cacheWrite: number; usd: number; at: number }
export type AdviceReason = 'boundary' | 'cold' | 'near-compact' | 'conversation' | 'plan-ready' | 'corrections' | 'handoff-saved'
export type Health = {
  cache: number
  warmMinutes: number
  ctx: number
  ctxLevel: 'success' | 'warning' | 'error'
  last: number
  coldUsd?: number
  fiveHour?: number
  sevenDay?: number
  /** What to do next when carrying on is not the best move; `command` is what the band shows after "next". */
  advice?: { verdict: 'compact' | 'clear' | 'handoff'; reason: AdviceReason; text: string; command: string }
}
export type PromptItem = RouteSpend & {
  id: string
  route: string
  label: string
  model: string
  effort?: Effort
  /** Its requests ran on more than one model; `model` is the last one. */
  isMixed?: boolean
}
export type PromptCost = { usd: number; requests: number; items: PromptItem[]; rewrites?: Rewrite[] }
export type PromptRecord = {
  at: number
  repo: string
  label: string
  text: string
  usd: number
  requests: number
  agents: number
  models?: Record<string, number>
  rewrites?: Rewrite[]
}
export type ActiveRoute = {
  route: string
  model: string
  effort?: Effort
  isHeld: boolean
}
export type LessonKind =
  | 'cold-rewrite'
  | 'switch-rewrite'
  | 'pricey-model'
  | 'context-high'
  | 'compacted'
  | 'subagents'
  | 'cache-expiring'
  | 'plan-toggle'
  | 'strategy'
  | 'handoff'
  | 'plan-ready'
  | 'corrections'
  | 'exploration'
  | 'auto-handoff'
/** Session facts a hot reload of the mod's code would otherwise drop: the prompt still running and the MCP and plugin use not yet saved. */
export type Carried = {
  sessionId?: string
  current?: { label: string; text: string; at: number }
  used: Record<string, { calls: number; lastUsed: number }>
  isUncounted: boolean
}
export type Lesson = { kind: LessonKind; at: number; repo: string; fact: string; usd?: number; isToasted?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      config: RouterConfig
      spend: Record<string, RouteSpend>
      isPlan: boolean
      active: ActiveRoute | null
      isBandShown: boolean
      draft: RouterConfig | null
      lastUsage: LastUsage | null
      health: Health | null
      promptCost: PromptCost | null
      history: PromptRecord[]
      statsScope: Scope
      lessons: Lesson[]
      lessonsReadAt: number
      learnOpen: LessonKind[]
      learnRows: string[]
      learnScope: Scope
      carried: Carried | null
    }
  }
}
