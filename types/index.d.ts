export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type RouteModel = ModelKey | 'inherit'
export type RouteEffort = Effort | 'auto' | 'inherit'
export type RouteSetting = { model: RouteModel; effort: RouteEffort }
export type RouterConfig = {
  isEnabled: boolean
  preset: string
  routes: Record<string, RouteSetting>
  cacheTtlMinutes?: number
  coldGuard?: ColdGuard
}
export type ColdGuard = 'refuse' | 'warn' | 'off'
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
export type Health = {
  cache: number
  warmMinutes: number
  ctx: number
  ctxLevel: 'success' | 'warning' | 'error'
  last: number
  toggle: number
  coldUsd?: number
  fiveHour?: number
  resetMinutes?: number
  sevenDay?: number
}
export type PromptItem = {
  id: string
  route: string
  label: string
  model: string
  effort?: string
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  usd: number
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
  effort?: string
  isHeld: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      config: RouterConfig
      spend: Record<string, RouteSpend>
      isPlan: boolean
      agents: Record<string, string>
      active: ActiveRoute | null
      isBandShown: boolean
      draft: RouterConfig | null
      lastUsage: LastUsage | null
      health: Health | null
      promptCost: PromptCost | null
      agentLabels: Record<string, string>
      history: PromptRecord[]
      statsScope: 'repo' | 'all'
    }
  }
}
