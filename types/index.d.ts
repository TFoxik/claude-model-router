export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'
export type RouteModel = ModelKey | 'inherit'
export type RouteEffort = Effort | 'auto' | 'inherit'
export type RouteSetting = { model: RouteModel; effort: RouteEffort }
export type RouterConfig = {
  isEnabled: boolean
  preset: string
  routes: Record<string, RouteSetting>
}
export type RouteSpend = {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  usd: number
}
export type LastUsage = { model: string; input: number; cacheRead: number; cacheWrite: number; usd: number }
export type Health = {
  cache: number
  ctx: number
  last: number
  toggle: number
  fiveHour?: number
  resetMinutes?: number
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
    }
  }
}
