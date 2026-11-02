/** Terminal control characters stripped from text the panes show but didn't write. */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')

/** `repo/CLAUDE.md`: a path's last two segments. */
export const shortPath = (path: string) => path.split('/').slice(-2).join('/')

/**
 * What a prompt says, out of the tags Claude Code wraps some prompts in: a slash command as `/name args`,
 * a message from an agent or the app by its tag (`agent message`), reminders dropped. Also takes text cut short mid-tag.
 */
export function typedText(raw: string): string {
  const text = raw.replace(/<system-reminder\b[\s\S]*?(<\/system-reminder>|$)/g, '').trim()
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]
  if (name !== undefined) return `${name} ${/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''}`.trim()
  if (text.startsWith('<command-')) return ''
  const wrapper = /^<([a-z]+(?:-[a-z]+)+)[\s>]/.exec(text)?.[1]
  return wrapper === undefined ? text : wrapper.replace(/-/g, ' ')
}

export function fmtAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(minutes / 60)
  return h > 0 ? `${h}h${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The `version` of a plugin.json, when it is a plain semver one: anything else is never shown. */
export function versionOf(manifest: string): string | undefined {
  try {
    const version = (JSON.parse(manifest) as { version?: unknown }).version
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}

export function commandLabel(text: string): string {
  const first = printable(text).trim().split(/\s+/)[0] ?? ''
  return first.startsWith('/') && first.length > 1 ? first : 'prompt'
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

export const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

export function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}
