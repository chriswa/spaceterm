/**
 * The header a Claude Code skill carries, and the lead a plain document has.
 *
 * Deliberately not a YAML parser. A `SKILL.md` header is a flat map of scalar
 * strings — `name` and `description` are the only two keys anything reads — and
 * pulling in a YAML dependency to reach them would buy nesting, anchors, and
 * type coercion that no skill file uses and that the renderer would then have to
 * carry. What is here is the subset that actually appears on disk: a `---`
 * fence, `key: value` lines, and folded continuations.
 *
 * Lives in `src/shared` because the *renderer* parses it. The content is
 * already streaming to the client for the editor, so parsing it there costs one
 * pass over a string that is in hand, and means a card re-renders its own header
 * as you type in it. Sending `name`/`description` as node fields instead would
 * put a server round-trip between the keystroke and the caption.
 */

export interface Frontmatter {
  /** The `name:` key, when the document has a well-formed header. */
  name?: string
  /** The `description:` key. */
  description?: string
  /** Everything after the closing fence — or the whole document when there is no header. */
  body: string
}

/** Lines that open or close a header block. `---` exactly, no trailing content. */
const FENCE = /^---[ \t]*$/

/** `key: value`, where the key is a bare word. Anything else is a continuation. */
const KEY_VALUE = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/

/**
 * Split a document into its header keys and its body.
 *
 * A document with no opening fence is all body — that is the CLAUDE.md case,
 * and it is not an error. A document whose fence never closes is *also* all
 * body: an unterminated header means the file is mid-edit or malformed, and
 * treating the rest of the file as header values would make the card show a
 * paragraph of prose as its title.
 *
 * Quotes around a value are stripped, since `name: "foo"` and `name: foo` mean
 * the same thing to Claude Code and should look the same on a card.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split('\n')

  // A header has to be the very first thing. Leading blank lines are tolerated
  // because editors add them, but any real content means there is no header.
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (start >= lines.length || !FENCE.test(lines[start])) {
    return { body: text }
  }

  let close = -1
  for (let i = start + 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      close = i
      break
    }
  }
  if (close === -1) return { body: text }

  const result: Frontmatter = { body: lines.slice(close + 1).join('\n') }
  let lastKey: 'name' | 'description' | null = null

  for (let i = start + 1; i < close; i++) {
    const line = lines[i]
    const match = KEY_VALUE.exec(line)
    if (match) {
      const key = match[1].toLowerCase()
      const value = unquote(match[2].trim())
      lastKey = key === 'name' || key === 'description' ? key : null
      if (lastKey) result[lastKey] = value
      continue
    }
    // A continuation line: YAML folds an indented run into the previous value.
    // Descriptions are routinely wrapped this way, and a card that showed only
    // the first line of one would cut off mid-sentence.
    if (lastKey && line.trim() !== '' && /^[ \t]/.test(line)) {
      const existing = result[lastKey]
      result[lastKey] = existing ? `${existing} ${line.trim()}` : line.trim()
    }
  }

  return result
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
}

/**
 * The caption a document shows when it is collapsed to one card face.
 *
 * Skills answer this from their header. A document without one — CLAUDE.md, the
 * whole reason this is not just `parseFrontmatter` — answers it from its shape
 * instead: the first `# ` heading for a title, and the first paragraph that
 * follows for the summary. That is the same rule `node-label.ts` already uses to
 * caption a markdown card, so the two agree about what a document is called.
 *
 * `fallbackName` is used when neither source yields a title; pass the file's own
 * name, which is what the user is looking for on a card that has nothing else.
 */
export function documentSummary(
  text: string,
  fallbackName: string
): { name: string; description: string | null } {
  const { name, description, body } = parseFrontmatter(text)
  if (name || description) {
    return { name: name || fallbackName, description: description ?? null }
  }

  const lines = body.split('\n')
  let heading: string | null = null
  let index = 0
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (trimmed === '') continue
    const match = /^#[ \t]+(\S.*?)\s*$/.exec(trimmed)
    if (match) {
      heading = match[1]
      index++
    }
    break
  }

  // The first prose paragraph after the heading, with headings and fenced code
  // skipped — a summary reading "npm run dev" because the document happens to
  // open with an example would be worse than no summary at all. The fence has
  // to be tracked as a *block*: skipping only its opening line leaves its
  // contents looking exactly like prose.
  const paragraph: string[] = []
  let inFence = false
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      if (paragraph.length > 0) break
      continue
    }
    if (inFence) continue
    if (trimmed === '') {
      if (paragraph.length > 0) break
      continue
    }
    if (trimmed.startsWith('#')) {
      if (paragraph.length > 0) break
      continue
    }
    paragraph.push(trimmed)
  }

  return {
    name: heading ?? fallbackName,
    description: paragraph.length > 0 ? paragraph.join(' ') : null
  }
}
