import type { ControlTranscriptEntry } from '../../../../shared/protocol'

/**
 * What the user has taken in of each part of Control's replies, as the
 * transcript view draws it — the client's half of the server's
 * `ConsumptionLedger`, worked out from the same record lines.
 *
 * A spoken reply was heard, unless a `heard` mark says how much of it was; a
 * reply written to a muted device waits to be read. What is left of a part is
 * `missing`: `missed` words, struck out — talked over, cut short, or marked by
 * the user as where they stopped — or words `waiting` for the user, written
 * to them muted or cut off while they were not there, until they read them
 * or their next message settles them.
 */

/** Characters `[from, to)` of a part. */
export type Span = readonly [number, number]

export interface PartView {
  /** What of the part was not taken in, in order. */
  missing: Span[]
  /** Why: lost to the user, or still waiting for them. */
  why: 'missed' | 'waiting'
}

/** Each reply's parts, by the reply's offset; only replies with something missing. */
export function partViews(entries: readonly ControlTranscriptEntry[]): Map<number, PartView[]> {
  const replies = new Map<number, { texts: string[]; taken: Span[][]; why: PartView['why'] }>()
  for (const entry of entries) {
    if (entry.kind === 'reply') {
      const text = entry.delivery === 'text'
      replies.set(entry.offset, {
        texts: entry.parts.map(part => part.text),
        taken: entry.parts.map(part => text ? [] : [[0, part.text.length]]),
        why: text ? 'waiting' : 'missed',
      })
    } else if (entry.kind === 'heard') {
      const reply = replies.get(entry.of)
      if (!reply) continue
      reply.taken = reply.texts.map((_, i) => (entry.parts[i] ?? 0) > 0 ? [[0, entry.parts[i]]] : [])
      reply.why = entry.unread ? 'waiting' : 'missed'
    } else if (entry.kind === 'consumed') {
      replies.get(entry.of)?.taken[entry.part]?.push([entry.from, entry.to])
    }
  }
  const views = new Map<number, PartView[]>()
  for (const [offset, reply] of replies) {
    const parts = reply.texts.map((text, i) => ({ missing: missingSpans(text.length, reply.taken[i]), why: reply.why }))
    if (parts.some(part => part.missing.length)) views.set(offset, parts)
  }
  return views
}

/**
 * The replies the user can still mark where they stopped taking in: what
 * Control has said since their last message. None while that message is not
 * loaded (`whole` is false), since the replies in view may not be all of it.
 */
export function openReplies(entries: readonly ControlTranscriptEntry[], whole: boolean): Set<number> {
  const open = new Set<number>()
  let found = whole
  for (const entry of entries) {
    if (entry.kind === 'user') {
      open.clear()
      found = true
    } else if (entry.kind === 'reply') {
      open.add(entry.offset)
    }
  }
  return found ? open : new Set()
}

/** What of `[0, length)` the spans leave out. */
function missingSpans(length: number, taken: readonly Span[]): Span[] {
  const missing: Span[] = []
  let at = 0
  for (const [from, to] of [...taken].sort((a, b) => a[0] - b[0])) {
    if (from > at) missing.push([at, Math.min(from, length)])
    at = Math.max(at, to)
  }
  if (at < length) missing.push([at, length])
  return missing.filter(([from, to]) => to > from)
}

/**
 * How a stretch of a part is drawn: taken in, `missed`, `waiting`, or — while
 * the voice is on it — still `unsaid`.
 */
export type SegmentKind = 'taken' | 'missed' | 'waiting' | 'unsaid'

/** A stretch of a part, from character `from`. */
export interface Segment { text: string; from: number; kind: SegmentKind }

/**
 * A part's text in segments, for drawing: as `view` has it, or, while the
 * voice says the reply, what it has said of the part taken in and the rest
 * `unsaid`. `played` already runs to the end of the word being said (see the
 * server's `playedLengths`), so that word is simply the last one lit.
 */
export function segments(text: string, view: PartView | undefined, played?: number): Segment[] {
  if (played !== undefined) {
    const said = Math.min(Math.max(0, played), text.length)
    return [
      { text: text.slice(0, said), from: 0, kind: 'taken' as const },
      { text: text.slice(said), from: said, kind: 'unsaid' as const },
    ].filter(segment => segment.text)
  }
  const out: Segment[] = []
  let at = 0
  for (const [from, to] of view?.missing ?? []) {
    if (from > at) out.push({ text: text.slice(at, from), from: at, kind: 'taken' })
    out.push({ text: text.slice(from, to), from, kind: view!.why })
    at = to
  }
  if (at < text.length) out.push({ text: text.slice(at), from: at, kind: 'taken' })
  return out
}

/**
 * A segment's words and the space between them; each word with where it
 * ends in the part, which is what clicking it marks as taken in up to.
 */
export function words(segment: Segment): Array<{ text: string; end?: number }> {
  return [...segment.text.matchAll(/\S+|\s+/g)].map(match => /\S/.test(match[0])
    ? { text: match[0], end: segment.from + match.index + match[0].length }
    : { text: match[0] })
}
