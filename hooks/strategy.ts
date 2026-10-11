import type { AdviceReason } from '../types'
import { CONTEXT_CRITICAL, CONTEXT_WARN, GUARD_MIN_TOKENS, SMALL_CONTEXT, contextFill, kTokens, modelKeyOf, money, plural, printable, rewritePrice } from './routes'
import { CORRECTIONS_MIN, OPEN_MIN } from './signals'

const CONVERSATION_SHARE = 0.6

export type Boundary = 'commit' | 'pr'
export type Verdict = 'continue' | 'compact' | 'clear' | 'handoff'

export type StrategyFacts = {
  tokens: number
  window: number
  compactAt?: number
  model: string
  ttlMinutes: number
  warmMinutes: number
  /** Share of the context the conversation itself takes, from the /context breakdown. */
  messagesShare?: number
  /** Work wrapped up since the person last prompted. */
  boundary?: Boundary
  /** Todos and tasks still pending or in progress. */
  openSteps?: number
  /** A plan written to disk, while no other file has been edited since. */
  planPath?: string
  /** Correcting prompts in a row. */
  corrections?: number
  hasHandoffSkill?: boolean
  /** An auto-handoff saved since the person last prompted. */
  handoffPath?: string
}

type Priced = { text: string; perRequestUsd: number }
export type Advice =
  | (Priced & { verdict: 'continue'; reason: 'small' | 'fine' })
  | (Priced & { verdict: 'compact' | 'clear' | 'handoff'; reason: AdviceReason; command: string })

/** Whether a shell command wraps up work: a commit, or a pull request opened or merged. */
export function boundaryOf(command: string): Boundary | undefined {
  // Quoted text is an argument, such as a commit message or an echo, never the command itself.
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  if (/\bgh\s+pr\s+(create|merge)\b/.test(bare)) return 'pr'
  if (/\bgit(?:\s+--?[\w-]+(?:=\S+|\s+[^\s-]\S*)?)*\s+commit(?![\w-])/.test(bare) && !/--dry-run/.test(bare)) return 'commit'
  return undefined
}

const BOUNDARY_TEXT: Record<Boundary, string> = { commit: 'Work was committed.', pr: 'A pull request went up.' }
const BOUNDARY_OPEN: Record<Boundary, string> = { commit: 'Work was committed', pr: 'A pull request went up' }

const handoffStep = (hasSkill?: boolean) =>
  hasSkill ? 'write a handoff with /handoff, /clear, then resume from it' : 'ask Claude to save the plan, progress and next steps to a file, /clear, then point the new session at it'

/** Whether to carry on, /compact, /clear or hand off, with the reason in dollars where the model has prices. */
export function adviseSession(f: StrategyFacts): Advice {
  const { warm, write } = rewritePrice(f.model, f.tokens, f.ttlMinutes)
  const isPriced = modelKeyOf(f.model) !== undefined
  const priced = (fragment: string) => (isPriced ? fragment : '')
  const advise = (verdict: Verdict, reason: Advice['reason'], text = '') =>
    ({
      verdict,
      reason,
      text,
      perRequestUsd: warm,
      ...(verdict === 'continue' ? {} : { command: verdict === 'handoff' && !f.hasHandoffSkill ? 'handoff' : `/${verdict}` }),
    }) as Advice
  const toward = contextFill(f.tokens, f.window, f.compactAt)
  const open = (f.openSteps ?? 0) >= OPEN_MIN ? (f.openSteps ?? 0) : 0
  const step = handoffStep(f.hasHandoffSkill)

  if (f.tokens < SMALL_CONTEXT) return advise('continue', 'small')
  if (f.handoffPath !== undefined && f.tokens >= GUARD_MIN_TOKENS) {
    const path = printable(f.handoffPath)
    return advise('clear', 'handoff-saved', `Handoff saved to ${path}: /clear, then say 'resume from ${path}'.`)
  }
  if (f.boundary !== undefined && f.tokens >= GUARD_MIN_TOKENS) {
    if (open > 0) {
      return advise(
        'handoff',
        'boundary',
        `${BOUNDARY_OPEN[f.boundary]} with ${plural(open, 'step')} still open. Each request re-reads ${kTokens(f.tokens)} tokens${priced(` (${money(warm)} warm)`)}: ${step}. A /compact summary keeps less of the plan.`,
      )
    }
    return advise(
      'clear',
      'boundary',
      `${BOUNDARY_TEXT[f.boundary]} Each further request re-reads the ${kTokens(f.tokens)} tokens of finished work${priced(` (${money(warm)} warm)`)}: /clear and start the next task fresh, or /compact to carry a summary.`,
    )
  }
  if (f.planPath !== undefined && f.tokens >= GUARD_MIN_TOKENS) {
    return advise(
      'clear',
      'plan-ready',
      `The plan is in ${printable(f.planPath)}, and the ${kTokens(f.tokens)} tokens of exploration behind it get re-read on every request${priced(` (${money(warm)} warm)`)}: /clear and ask Claude to implement the plan file in a fresh context.`,
    )
  }
  if (f.warmMinutes === 0 && f.tokens >= GUARD_MIN_TOKENS) {
    const steps = open > 0 ? ` ${plural(open, 'step')} are open: a handoff keeps them, but writing it also pays the rewrite; with a plan file on disk, /clear and resume from it.` : ''
    return advise('clear', 'cold', `The cache went cold: the next send, /compact included, re-writes ${kTokens(f.tokens)} tokens${priced(` for ${money(write)}`)}. /clear is free.${steps}`)
  }
  if ((f.corrections ?? 0) >= CORRECTIONS_MIN) {
    return advise(
      'clear',
      'corrections',
      `${f.corrections} corrections in a row over ${kTokens(f.tokens)} tokens: the failed attempts stay in context and steer the next try. /clear and start over with one prompt that says what you learned, or press Esc Esc to rewind to before the first attempt.`,
    )
  }
  if (toward >= CONTEXT_CRITICAL) {
    const where = f.compactAt ? `${kTokens(Math.max(0, f.compactAt - f.tokens))} tokens to auto-compact` : `${Math.round(toward * 100)}% of the context window used`
    if (open > 0) return advise('handoff', 'near-compact', `${where} with ${plural(open, 'step')} open: ${step}. A summary written mid-plan drops detail the next steps need.`)
    return advise('compact', 'near-compact', `${where}: /compact now and say what to keep (the plan, open TODOs, touched files), rather than let it fire mid-task.`)
  }
  if (toward >= CONTEXT_WARN && (f.messagesShare ?? 0) >= CONVERSATION_SHARE) {
    const head = `The conversation is ${Math.round((f.messagesShare ?? 0) * 100)}% of ${kTokens(f.tokens)} tokens${priced(`, re-read for ${money(warm)} a request`)}`
    if (open > 0) return advise('handoff', 'conversation', `${head}: ${plural(open, 'step')} are open, so ${step}.`)
    return advise(
      'compact',
      'conversation',
      `${head}: /compact to keep a summary, Esc Esc → Summarize up to here condenses old turns and keeps recent ones whole, or /clear once this task is done.`,
    )
  }
  return advise('continue', 'fine')
}
