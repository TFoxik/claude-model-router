import { contextLevel, kTokens, printable, shortPath } from '../routes'
import { contextTips, tokensByServer } from '../tips'
import type { Breakdown } from '../tips'
import { tipsSection } from './kit'
import type { Els } from './kit'

// Theme keys as hex, for the one place a theme key cannot go: an SVG drawn as an image.
const HEX: Record<string, string> = {
  claude: '#d97757',
  planMode: '#5fb36b',
  suggestion: '#6ea8e0',
  success: '#5fb36b',
  warning: '#e0b24f',
  error: '#e06c6c',
  permission: '#9a8fe0',
  autoAccept: '#b48ee0',
  remember: '#6ea8e0',
  merged: '#a87fd6',
  ide: '#4fa3b8',
  bashBorder: '#e07fb0',
}
const hexOf = (key: string | undefined) => (key && key.startsWith('#') ? key : HEX[key ?? ''] ?? '#9a9893')

type Segment = { tokens: number; color?: string }

/** One horizontal bar of segments, as an SVG for surfaces that draw them. */
function stackedSvg(segments: readonly Segment[], whole: number): string {
  const w = 600
  let x = 0
  const rects = segments
    .filter(one => one.tokens > 0)
    .map(one => {
      const width = Math.max(1, (one.tokens / whole) * w)
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="14" fill="${hexOf(one.color)}"/>`
      x += width
      return rect
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 14" width="${w}" height="14"><rect width="${w}" height="14" rx="3" fill="#8b8a86" fill-opacity="0.18"/>${rects}</svg>`
}

/** The same bar as coloured block characters, for the monospace terminal. */
function stackedCells(segments: readonly Segment[], whole: number, width: number): Array<{ text: string; color?: string }> {
  const out = segments
    .filter(one => one.tokens > 0)
    .map(one => ({ text: '█'.repeat(Math.max(1, Math.round((one.tokens / whole) * width))), color: one.color }))
  const used = out.reduce((sum, one) => sum + one.text.length, 0)
  return used < width ? [...out, { text: '░'.repeat(width - used), color: undefined }] : out
}

export function contextMobileView({ Text }: Els) {
  return <Text dimColor>Open the context breakdown from a terminal or desktop.</Text>
}

type ContextData = { breakdown: Breakdown | undefined; isTerminal: boolean; columns: number }

export function contextPaneView(els: Els, { breakdown: b, isTerminal, columns }: ContextData) {
  const { Box, Text } = els
  const Svg = 'Svg' in els ? els.Svg : undefined
  if (b === undefined) return <Text dimColor>No context breakdown available yet.</Text>
  const used = b.categories.filter(one => one.kind === 'used').sort((x, y) => y.tokens - x.tokens)
  const deferred = b.categories.filter(one => one.kind === 'deferred')
  const free = b.categories.find(one => one.kind === 'free')
  const buffer = b.categories.find(one => one.kind === 'buffer')
  const topServers = [...tokensByServer(b.mcpTools)].sort((x, y) => y[1] - x[1]).slice(0, 5)
  const topMemory = [...b.memoryFiles].sort((x, y) => y.tokens - x.tokens).slice(0, 5)
  const untilCompact = b.autoCompactThreshold === undefined ? undefined : b.autoCompactThreshold - b.totalTokens
  const pct = (tokens: number) => `${((tokens / b.rawMaxTokens) * 100).toFixed(1)}%`
  const width = Math.max(10, columns - 2)
  const segments: Segment[] = used.map(one => ({ tokens: one.tokens, color: one.color }))
  const line = (key: string, name: string, tokens: number, color?: string, isDim?: boolean) => (
    <Box key={key} flexDirection="row" gap={1}>
      <Box width={2} flexShrink={0}>
        <Text color={color} dimColor={isDim}>●</Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end">
        <Text dimColor={isDim}>{kTokens(tokens)}</Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{pct(tokens)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text dimColor={isDim} wrap="truncate-end">{name}</Text>
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">Context</Text>
        <Text bold color={contextLevel(b.totalTokens, b.rawMaxTokens, b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined)}>
          {kTokens(b.totalTokens)} / {kTokens(b.rawMaxTokens)} · {b.percentage}%
        </Text>
      </Box>
      {isTerminal || Svg === undefined ? (
        <Text>
          {stackedCells(segments, b.rawMaxTokens, width).map((one, i) => (
            <Text key={`c:${i}`} color={one.color} dimColor={one.color === undefined}>
              {one.text}
            </Text>
          ))}
        </Text>
      ) : (
        <Svg source={stackedSvg(segments, b.rawMaxTokens)} alt={`${b.percentage}% of the context window in use`} />
      )}
      <Text dimColor>
        {b.isAutoCompactEnabled && untilCompact !== undefined
          ? `auto-compact at ${kTokens(b.autoCompactThreshold ?? 0)} · ${kTokens(Math.max(0, untilCompact))} to go`
          : 'auto-compact off'}
      </Text>
      <Box flexDirection="column">
        <Text bold dimColor>IN USE</Text>
        {used.map(one => line(`u:${one.name}`, one.name, one.tokens, one.color))}
      </Box>
      <Box flexDirection="column">
        <Text bold dimColor>NOT SENT</Text>
        {deferred.map(one => line(`d:${one.name}`, one.name.replace(/ \(deferred\)$/, ''), one.tokens, undefined, true))}
        {free ? line('free', 'Free space', free.tokens, undefined, true) : null}
        {buffer ? line('buffer', 'Compaction buffer', buffer.tokens, undefined, true) : null}
      </Box>
      {topServers.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>MCP SERVERS</Text>
          {topServers.map(([name, tokens]) => line(`m:${name}`, printable(name), tokens, 'suggestion'))}
        </Box>
      ) : null}
      {topMemory.length > 0 ? (
        <Box flexDirection="column">
          <Text bold dimColor>MEMORY FILES</Text>
          {topMemory.map(one => line(`f:${one.path}`, printable(`${one.type} · ${shortPath(one.path)}`), one.tokens, 'planMode'))}
        </Box>
      ) : null}
      {tipsSection(els, contextTips(b))}
      <Text dimColor>
        {b.skills ? `skills listing ${kTokens(b.skills.tokens)} (${b.skills.includedSkills}/${b.skills.totalSkills}) · ` : ''}
        {b.model} · estimated locally, as /context does
      </Text>
    </Box>
  )
}
