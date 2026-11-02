import type { LessonDraft } from './lessons'

// Lessons the running main-loop turn has taught so far; kept or dropped when it ends.
let pending: LessonDraft[] = []

export function pushLesson(draft: LessonDraft | undefined): void {
  if (draft !== undefined) pending.push(draft)
}

export function takeLessons(): LessonDraft[] {
  const drafts = pending
  pending = []
  return drafts
}

export function dropLessons(): void {
  pending = []
}

// Lessons that can't wait for a turn to end, kept until a status refresh that teaches them runs, whichever refresh measured them.
let urgent: LessonDraft[] = []

export function pushUrgent(draft: LessonDraft): void {
  urgent.push(draft)
}

export function takeUrgent(): LessonDraft[] {
  const drafts = urgent
  urgent = []
  return drafts
}
