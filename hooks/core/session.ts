import type { Timer } from 'claude-code'
import type { Carried, Effort } from '../../types'
import { NO_STEPS } from './signals'
import type { Boundary, Steps } from './signals'

type Session = {
  repo: string
  home?: string
  // The repo's root, for commands a tip puts in the prompt.
  root?: string
  // MCP servers and plugins used since the last save, whether this session has been counted yet, and the running prompt.
  kept: Carried
  isTurnRunning: boolean
  isAfterCompact: boolean
  lastMain?: { route: string; model: string; effort?: Effort; at: number }
  // Each agent's route, label and the prompt that started it (its `current.at`), when spawned in view.
  agents: Map<string, { route: string; label?: string; promptAt?: number }>
  // The label of the prompt the next turn.start opens; undefined while a prompt's turns run.
  pendingPrompt?: string
  // Work wrapped up (a commit, a PR) since the person last prompted.
  boundary?: Boundary
  // Todos and tasks open, a plan on disk with no other edit since, correcting prompts in a row, and read/search tokens since the last fresh context.
  steps: Steps
  // File edits since the last git commit, by any agent; outlives a compaction like the steps.
  editsSinceCommit: number
  planPath?: string
  corrections: number
  explored: number
  isExploreTaught: boolean
  hasHandoffSkill: boolean
  // An auto-handoff saved since the person last prompted.
  handoffPath?: string
  compactAt?: number
  compactCheckedAt?: number
  messagesShare?: number
  tick?: Timer
}

/** Per-load memory shared by the core and the features: a hot reload starts it over, which only costs one unguarded turn. Core and register.tsx write it, and a feature the fields it owns (`handoffPath`, `isAfterCompact`). */
export const session: Session = {
  repo: 'unknown',
  kept: { used: {}, isUncounted: true },
  isTurnRunning: false,
  isAfterCompact: false,
  agents: new Map(),
  pendingPrompt: 'prompt',
  steps: NO_STEPS,
  editsSinceCommit: 0,
  corrections: 0,
  explored: 0,
  isExploreTaught: false,
  hasHandoffSkill: false,
}
