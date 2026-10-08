import type { ControlTranscriptEntry } from '../../../../shared/protocol'

/**
 * What the user has taken in of each part of Control's replies, as the
 * transcript view draws it — the client's half of the server's
 * `ConsumptionLedger`, worked out from the same record lines.
 *
 * A spoken reply was heard, unless a `heard` mark says it was cut off; a
 * reply written to a muted device was not read, until `consumed` marks say
 * it was. What is left is `missing`: `unheard` words the voice never reached,
 * or `unread` ones still waiting to be read.
 */

/** Characters `[from, to)` of a part. */
export type Span = readonly [number, number]

export interface PartView {
  /** What of the part was never heard or read, in order. */
  missing: Span[]
  /** Why: cut off while spoken, or written and not read yet. */
  why: 'unheard' | 'unread'
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
        why: text ? 'unread' : 'unheard',
      })
    } else if (entry.kind === 'heard') {
      const reply = replies.get(entry.of)
      if (!reply) continue
      reply.taken = reply.texts.map((_, i) => (entry.parts[i] ?? 0) > 0 ? [[0, entry.parts[i]]] : [])
      if (entry.unread) reply.why = 'unread'
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

/** A part's text in runs, each taken in or missing, for drawing. */
export function runs(text: string, missing: readonly Span[]): Array<{ text: string; missing: boolean }> {
  const out: Array<{ text: string; missing: boolean }> = []
  let at = 0
  for (const [from, to] of missing) {
    if (from > at) out.push({ text: text.slice(at, from), missing: false })
    out.push({ text: text.slice(from, to), missing: true })
    at = to
  }
  if (at < text.length) out.push({ text: text.slice(at), missing: false })
  return out
}
