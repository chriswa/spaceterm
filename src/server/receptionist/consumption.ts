import type { ControlTranscriptEntry } from '../../shared/protocol'

/**
 * What the user has actually taken in of Control's replies, as against what
 * Control believes they have — and the note that brings the two back in step.
 *
 * Control writes every reply knowing all of it, and assumes it was heard. Two
 * things break that. Words can go unheard: cut off, or written to a muted
 * device and not read yet. Then Control must not build on them, which is the
 * dangerous direction. And words missed can be taken in later: read in the
 * transcript, or heard replayed. Then Control should stop repeating them,
 * which is only annoying, but is what makes replay and reading worth doing.
 *
 * So nothing counts as taken in without evidence — a reply spoken through is
 * evidence; a muted one is not, until it has been on screen — and Control is
 * told what changed only when it next hears anything (`note`), never with a
 * turn of its own: the moment it matters is when it writes something next.
 *
 * Ranges are characters of each part as stored in the record — the words the
 * model wrote, without the "Kevin here." Control's speech puts in front.
 */

export type Delivery = 'spoken' | 'text'
export type ConsumedHow = 'read' | 'replayed' | 'summary'

/** Characters `[from, to)`. */
type Range = readonly [number, number]

interface Tracked {
  texts: string[]
  delivery: Delivery
  /** What the user has taken in of each part. */
  consumed: Range[][]
  /**
   * What Control believes they have of each part; undefined for all of it,
   * which is what it assumes of any reply until it is told otherwise.
   */
  believed: Range[][] | undefined
}

/** Replies followed, newest kept: older ones are long past mattering to the next turn. */
const KEEP_REPLIES = 40
/** The most of any one stretch of words quoted back to the model. */
const QUOTE_CHARS = 240

export class ConsumptionLedger {
  /** By where each reply is in the record; insertion order is record order. */
  private readonly replies = new Map<number, Tracked>()

  /** A reply said (`spoken`, taken in unless `heard` says otherwise) or written to a muted device (`text`, taken in only once read). */
  delivered(at: number, texts: readonly string[], delivery: Delivery): void {
    this.replies.set(at, {
      texts: [...texts],
      delivery,
      consumed: texts.map(text => delivery === 'spoken' ? [[0, text.length] as const] : []),
      believed: undefined,
    })
    while (this.replies.size > KEEP_REPLIES) this.replies.delete(this.replies.keys().next().value!)
  }

  /**
   * The reply at `at` was cut off, `lengths[i]` characters into part `i`.
   * Control is told so at once, by the note `noteInterruption` writes, so it
   * believes exactly that much. `unread` when the rest went on as text — the
   * user muted it mid-reply — rather than being lost.
   */
  heard(at: number, lengths: readonly number[], unread = false): void {
    const reply = this.replies.get(at)
    if (!reply) return
    reply.consumed = reply.texts.map((text, i) => {
      const heard = Math.min(text.length, lengths[i] ?? 0)
      return heard > 0 ? [[0, heard] as const] : []
    })
    reply.believed = clone(reply.consumed)
    if (unread) reply.delivery = 'text'
  }

  /**
   * Part `part` of the reply at `at` taken in, `from` to `to` (at most its
   * length). Returns the range, kept to the part, if that was news. `told`
   * when Control is being told some other way, so `note` need not.
   */
  consume(at: number, part: number, from: number, to: number, told = false): { from: number; to: number } | undefined {
    const reply = this.replies.get(at)
    const text = reply?.texts[part]
    if (!reply || text === undefined) return undefined
    const range = [Math.max(0, from), Math.min(text.length, to)] as const
    if (range[1] <= range[0] || subtract([range], reply.consumed[part]).length === 0) return undefined
    reply.consumed[part] = merge([...reply.consumed[part], range])
    if (told && reply.believed) reply.believed[part] = merge([...reply.believed[part], range])
    if (told && reply.believed && complete(reply, reply.believed)) reply.believed = undefined
    return { from: range[0], to: range[1] }
  }

  /** Replies written to a muted device and not wholly read yet, and where the oldest is. */
  unread(): { count: number; first?: number } {
    const unread = [...this.replies].filter(([, reply]) => reply.delivery === 'text' && !complete(reply))
    return { count: unread.length, ...(unread.length ? { first: unread[0][0] } : {}) }
  }

  /** What is still to be read, part by part, for a catch-up to take in. */
  unreadParts(): Array<{ at: number; part: number; from: number; to: number; text: string }> {
    const parts: Array<{ at: number; part: number; from: number; to: number; text: string }> = []
    for (const [at, reply] of this.replies) {
      if (reply.delivery !== 'text') continue
      reply.texts.forEach((text, part) => {
        for (const [from, to] of subtract([[0, text.length]], reply.consumed[part])) {
          parts.push({ at, part, from, to, text: text.slice(from, to) })
        }
      })
    }
    return parts
  }

  /**
   * What Control should be told before it next writes anything, if anything:
   * replies it assumes were taken in that were not, and words it was told
   * went unheard that have been taken in since. Telling it brings its belief
   * up to date, so each change is told once.
   */
  note(): string | undefined {
    const unread: string[] = []
    const since: string[] = []
    for (const reply of this.replies.values()) {
      if (reply.believed === undefined) {
        if (reply.delivery !== 'text' || complete(reply)) continue
        unread.push(quote(reply.texts.join(' ')))
        reply.believed = clone(reply.consumed)
        continue
      }
      const gained = reply.texts.flatMap((text, i) =>
        subtract(reply.consumed[i], reply.believed![i]).map(([from, to]) => text.slice(from, to).trim()))
        .filter(Boolean)
      if (gained.length) since.push(quote(gained.join(' … ')))
      reply.believed = complete(reply) ? undefined : clone(reply.consumed)
    }
    const notes: string[] = []
    if (unread.length) {
      notes.push(`${unread.length === 1 ? 'A reply of yours was' : `${unread.length} replies of yours were`} written to the user rather than spoken, and they have not read ${unread.length === 1 ? 'it' : 'them'} yet: ${unread.join('; ')}. ` +
        'Do not assume they know what it says; if you act on any of it, say so when you report what you did.')
    }
    if (since.length) {
      notes.push(`Since then, the user has read, or heard replayed, what they had missed of your earlier words: ${since.join('; ')}. ` +
        'Treat it as known: do not say it again, and drop it from your backlog if it is there.')
    }
    return notes.length ? notes.join(' ') : undefined
  }

  /**
   * The ledger as the record left it, after a restart: the record's last
   * entries, oldest first. Whatever Control was due to be told went with the
   * notes the last server carried over, so it believes what was taken in.
   */
  restore(entries: readonly ControlTranscriptEntry[]): void {
    for (const entry of entries) {
      if (entry.kind === 'reply') this.delivered(entry.offset, entry.parts.map(part => part.text), entry.delivery ?? 'spoken')
      else if (entry.kind === 'heard') this.heard(entry.of, entry.parts, entry.unread === true)
      else if (entry.kind === 'consumed') this.consume(entry.of, entry.part, entry.from, entry.to)
    }
    for (const reply of this.replies.values()) reply.believed = complete(reply) ? undefined : clone(reply.consumed)
  }
}

/** Whether `ranges` (what was consumed, by default) covers every part whole. */
function complete(reply: Tracked, ranges: Range[][] = reply.consumed): boolean {
  return reply.texts.every((text, i) => subtract([[0, text.length]], ranges[i]).length === 0)
}

function clone(ranges: Range[][]): Range[][] {
  return ranges.map(part => [...part])
}

/** Sorted, with overlapping and touching ranges joined. */
function merge(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: Array<[number, number]> = []
  for (const [from, to] of sorted) {
    const last = out.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  return out
}

/** What of `ranges` is not in `minus`. */
function subtract(ranges: readonly Range[], minus: readonly Range[]): Range[] {
  let left: Range[] = merge(ranges)
  for (const [from, to] of merge(minus)) {
    left = left.flatMap(([a, b]): Range[] => {
      if (to <= a || from >= b) return [[a, b]]
      return [...(from > a ? [[a, from] as const] : []), ...(to < b ? [[to, b] as const] : [])]
    })
  }
  return left.filter(([a, b]) => b > a)
}

function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return `"${clean.length > QUOTE_CHARS ? `${clean.slice(0, QUOTE_CHARS - 1)}…` : clean}"`
}
