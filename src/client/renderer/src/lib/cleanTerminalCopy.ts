/**
 * Cleans text selected from a terminal (typically Claude Code output) for
 * downstream consumers like the system clipboard and the Cartesia TTS
 * subprocess. Strips box-drawing borders, the Claude Code "⏺ " prefix and
 * its 2-space continuation indent, and any common leading whitespace.
 */
export function cleanTerminalCopy(raw: string): string {
  // Strip box-drawing border characters (│, ─, ╭, etc.) from line edges, then trailing whitespace
  let lines = raw.split('\n').map(l =>
    l.replace(/^[─-╿]+ ?/, '').replace(/ *[─-╿]+$/, '').trimEnd()
  )

  // Detect Claude Code output pattern: "⏺ " prefix, subsequent lines blank or 2+ space indented
  if (lines.length > 0 && lines[0].startsWith('⏺ ')) {
    const rest = lines.slice(1)
    const isClaude = rest.every(l => l === '' || l.startsWith('  '))
    if (isClaude) {
      lines[0] = lines[0].slice('⏺ '.length)
      lines = [lines[0], ...rest.map(l => l === '' ? '' : l.slice(2))]
    }
  }

  // Dedent: strip common leading whitespace
  const indents = lines.filter(l => l.length > 0).map(l => l.match(/^ */)![0].length)
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0
  if (minIndent > 0) {
    lines = lines.map(l => l.length > 0 ? l.slice(minIndent) : l)
  }

  return lines.join('\n')
}
