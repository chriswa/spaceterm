/**
 * Cleans text selected from a terminal (typically Claude Code output or shell
 * prompts) for downstream consumers like the system clipboard and the Cartesia
 * TTS subprocess. The pipeline is:
 *
 *   1. Strip box-drawing border characters from line edges + trailing space.
 *   2. If line 1 starts with a single non-alphanumeric "marker" char + space
 *      (e.g. "⏺ ", "❯ ", "> ", "$ ") and every subsequent non-blank line
 *      starts with a matching continuation indent, strip the marker and the
 *      indent. Falls through gracefully when the heuristic doesn't apply.
 *   3. Dedent: strip the common leading whitespace from all non-blank lines.
 *   4. Soft-wrap join: collapse adjacent non-blank lines into a single logical
 *      line, since xterm emits one newline per visual row regardless of
 *      whether the break was a soft wrap or a hard newline. Don't join when
 *      the next line opens a new structural block (list item, heading, code
 *      fence, blockquote, table row, indented code).
 *
 * To extend the rules safely, add a new fixture in cleanTerminalCopy.test.ts
 * before editing this file — see .claude/skills/copy-cleanup-fix/.
 */
export function cleanTerminalCopy(raw: string): string {
  let lines = raw.split('\n').map(l =>
    l.replace(/^[─-╿]+ ?/, '').replace(/ *[─-╿]+$/, '').trimEnd()
  )

  // Generalized prefix detection: any single non-letter/non-digit/non-space
  // character followed by a space, when every non-blank rest line starts with
  // a matching indent. Covers `⏺ `, `❯ `, `> `, `$ `, `# `, etc.
  if (lines.length > 0) {
    const match = lines[0].match(/^([^A-Za-z0-9\s]) /)
    if (match) {
      const indent = match[0].length // typically 2
      const pad = ' '.repeat(indent)
      const rest = lines.slice(1)
      const indentConsistent = rest.every(l => l === '' || l.startsWith(pad))
      if (indentConsistent) {
        lines = [lines[0].slice(indent), ...rest.map(l => l === '' ? '' : l.slice(indent))]
      }
    }
  }

  // Dedent
  const indents = lines.filter(l => l.length > 0).map(l => l.match(/^ */)![0].length)
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0
  if (minIndent > 0) {
    lines = lines.map(l => l.length > 0 ? l.slice(minIndent) : l)
  }

  // Soft-wrap join. Adjacent non-blank lines are joined into one unless the
  // current line begins a new structural block. Whitespace at the join seam
  // is normalised to a single space so a wrap-onto-leading-space (e.g. the
  // "...kind\n of..." pattern) collapses cleanly.
  const STRUCTURAL: RegExp[] = [
    /^\d+[.)]\s/,   // numbered list:  1.   1)
    /^[-*•+]\s/,    // bullet:  -   *   •   +
    /^#+\s/,        // markdown heading
    /^```/,         // code fence (backtick)
    /^~~~/,         // code fence (tilde)
    /^>\s/,         // blockquote
    /^\|/,          // table row
    /^ {4,}\S/,     // indented code block (4+ spaces survived dedent → real extra indent)
  ]
  const isStructural = (line: string): boolean => STRUCTURAL.some(r => r.test(line))

  const joined: string[] = []
  for (const line of lines) {
    if (joined.length === 0 || line === '') {
      joined.push(line)
      continue
    }
    const prev = joined[joined.length - 1]
    if (prev === '' || isStructural(line)) {
      joined.push(line)
      continue
    }
    joined[joined.length - 1] = prev.replace(/\s+$/, '') + ' ' + line.replace(/^\s+/, '')
  }

  return joined.join('\n')
}
