import type { LessonDraft } from './lessons'

// Lessons the running main-loop turn has taught so far; kept or dropped when it ends.
let pending: LessonDraft[] = []

export function pushLesson(draft: LessonDraft | undefined): void {
  if (draft !== undefined) pending.push(draft)
}

/** What the turn taught so far, which it then forgets. */
export function takeLessons(): LessonDraft[] {
  const drafts = pending
  pending = []
  return drafts
}

export function dropLessons(): void {
  pending = []
}
