import { CONTEXT_CRITICAL, CONTEXT_WARN, GUARD_MIN_TOKENS, SMALL_CONTEXT, contextFill, kTokens, modelKeyOf, money, rewritePrice } from './routes'

const CONVERSATION_SHARE = 0.6

export type Boundary = 'commit' | 'pr'
export type Verdict = 'continue' | 'compact' | 'clear'

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
}

type Priced = { text: string; perRequestUsd: number }
export type Advice =
  | (Priced & { verdict: 'continue'; reason: 'small' | 'fine' })
  | (Priced & { verdict: 'compact' | 'clear'; reason: 'boundary' | 'cold' | 'near-compact' | 'conversation' })

/** Whether a shell command wraps up work: a commit, or a pull request opened or merged. */
export function boundaryOf(command: string): Boundary | undefined {
  // Quoted text is an argument, such as a commit message or an echo, never the command itself.
  const bare = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
  if (/\bgh\s+pr\s+(create|merge)\b/.test(bare)) return 'pr'
  if (/\bgit(?:\s+--?[\w-]+(?:=\S+|\s+[^\s-]\S*)?)*\s+commit(?![\w-])/.test(bare) && !/--dry-run/.test(bare)) return 'commit'
  return undefined
}

const BOUNDARY_TEXT: Record<Boundary, string> = { commit: 'Work was committed.', pr: 'A pull request went up.' }

/** Whether to carry on, /compact or /clear, with the reason in dollars where the model has prices. */
export function adviseSession(f: StrategyFacts): Advice {
  const { warm, write } = rewritePrice(f.model, f.tokens, f.ttlMinutes)
  const isPriced = modelKeyOf(f.model) !== undefined
  const priced = (fragment: string) => (isPriced ? fragment : '')
  const advise = (verdict: Verdict, reason: Advice['reason'], text = '') => ({ verdict, reason, text, perRequestUsd: warm }) as Advice
  const toward = contextFill(f.tokens, f.window, f.compactAt)

  if (f.tokens < SMALL_CONTEXT) return advise('continue', 'small')
  if (f.boundary !== undefined && f.tokens >= GUARD_MIN_TOKENS) {
    return advise(
      'clear',
      'boundary',
      `${BOUNDARY_TEXT[f.boundary]} Each further request re-reads the ${kTokens(f.tokens)} tokens of finished work${priced(` (${money(warm)} warm)`)}: /clear and start the next task fresh, or /compact to carry a summary.`,
    )
  }
  if (f.warmMinutes === 0 && f.tokens >= GUARD_MIN_TOKENS) {
    return advise('clear', 'cold', `The cache went cold: the next send, /compact included, re-writes ${kTokens(f.tokens)} tokens${priced(` for ${money(write)}`)}. /clear is free.`)
  }
  if (toward >= CONTEXT_CRITICAL) {
    const where = f.compactAt ? `${kTokens(Math.max(0, f.compactAt - f.tokens))} tokens to auto-compact` : `${Math.round(toward * 100)}% of the context window used`
    return advise('compact', 'near-compact', `${where}: /compact now and say what to keep (the plan, open TODOs, touched files), rather than let it fire mid-task.`)
  }
  if (toward >= CONTEXT_WARN && (f.messagesShare ?? 0) >= CONVERSATION_SHARE) {
    return advise(
      'compact',
      'conversation',
      `The conversation is ${Math.round((f.messagesShare ?? 0) * 100)}% of ${kTokens(f.tokens)} tokens${priced(`, re-read for ${money(warm)} a request`)}: /compact to keep a summary, or /clear once this task is done.`,
    )
  }
  return advise('continue', 'fine')
}
