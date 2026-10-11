export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Steps = { todos: number; tasks: Record<string, StepStatus> }
export type PlanEvent = { kind: 'saved'; path: string } | { kind: 'work' } | undefined

export const NO_STEPS: Steps = { todos: 0, tasks: {} }
export const OPEN_MIN = 2
export const CORRECTIONS_MIN = 2
export const EXPLORE_MIN = 30_000
export const EXPLORE_SHARE = 0.3

const isOpen = (status: unknown) => status === 'pending' || status === 'in_progress'
const isStatus = (status: unknown): status is StepStatus => isOpen(status) || status === 'completed'

/** The steps after one finished tool call: a todo list replaces the count, a task is added, moved or dropped. */
export function stepsAfter(steps: Steps, tool: string, input: Record<string, unknown>, result: unknown): Steps {
  if (tool === 'TodoWrite') {
    const todos = (result as { newTodos?: unknown } | null | undefined)?.newTodos ?? input.todos
    return Array.isArray(todos) ? { ...steps, todos: todos.filter(one => isOpen((one as { status?: unknown } | null)?.status)).length } : steps
  }
  if (tool === 'TaskCreate') {
    const id = (result as { task?: { id?: unknown } } | null | undefined)?.task?.id
    return typeof id === 'string' ? { ...steps, tasks: { ...steps.tasks, [id]: 'pending' } } : steps
  }
  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = input.taskId
    const rest = Object.fromEntries(Object.entries(steps.tasks).filter(([one]) => one !== id))
    if (input.status === 'deleted') return { ...steps, tasks: rest }
    if (isStatus(input.status)) return { ...steps, tasks: { ...rest, [id]: input.status } }
  }
  return steps
}

export const openSteps = (steps: Steps) => steps.todos + Object.values(steps.tasks).filter(isOpen).length

const PLAN_FILE = /(^|\/)(specs|plans)\/[^/]+\.md$|(^|\/)(SPEC|PLAN)\.md$/
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

/** A plan written to disk, or work started on something else, from one finished tool call. */
export function planEventOf(tool: string, input: Record<string, unknown>, result: unknown): PlanEvent {
  if (tool === 'ExitPlanMode') {
    const path = (result as { filePath?: unknown } | null | undefined)?.filePath
    return typeof path === 'string' && path !== '' ? { kind: 'saved', path } : undefined
  }
  if (!EDIT_TOOLS.has(tool)) return undefined
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined
  if (path === undefined) return undefined
  return PLAN_FILE.test(path) ? { kind: 'saved', path } : { kind: 'work' }
}

const CORRECTION = [
  /^(no|nope)([,.!]|\s*$)/,
  /^(wrong|again)\b/,
  /\bstill (fail|failing|fails|broken|wrong|not|doesn'?t|does not|isn'?t|is not|the same)\b/,
  /\b(that'?s|this is|it'?s|that is|it is) (wrong|not (it|right|what))/,
  /\b(didn'?t|doesn'?t|does not|did not) work\b/,
  /\bnot what i (asked|meant|wanted)\b/,
  /\bsame (error|problem|issue|bug)\b/,
]

/** Whether a prompt you typed corrects the last attempt rather than asking for something new. */
export function isCorrection(text: string): boolean {
  const head = text.trim().slice(0, 200).toLowerCase().replace(/’/g, "'")
  return head !== '' && !head.startsWith('/') && CORRECTION.some(re => re.test(head))
}

const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Grep', 'Glob', 'WebFetch'])

function textChars(value: unknown, depth: number): number {
  if (typeof value === 'string') return value.length
  if (depth > 4 || typeof value !== 'object' || value === null) return 0
  if (Array.isArray(value)) return value.reduce((n: number, one) => n + textChars(one, depth + 1), 0)
  return Object.entries(value).reduce((n, [key, one]) => (key === 'base64' ? n : n + textChars(one, depth + 1)), 0)
}

/** Tokens a read or search put into the context, estimated at four characters a token; other tools count nothing. */
export const exploredTokens = (tool: string, result: unknown) => (EXPLORE_TOOLS.has(tool) ? Math.round(textChars(result, 0) / 4) : 0)

export const isExplorationHeavy = (explored: number, total: number) => total > 0 && explored >= EXPLORE_MIN && explored >= total * EXPLORE_SHARE

export const hasHandoffCommand = (names: readonly string[]) => names.some(name => name === 'handoff' || name.endsWith(':handoff'))
