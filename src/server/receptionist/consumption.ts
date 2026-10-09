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
 * What the user did not take in of a reply is either lost — talked over,
 * cut short by Control, or marked by the user as where they stopped — or
 * `waiting`: written to them muted, or cut off while they were not there to
 * hear it. Waiting words are not counted against them until they next say
 * something to Control, which settles them (`settle`): typed in the
 * transcript, they were read there; spoken, they were not, and are lost.
 *
 * Everything Control has said since the user's last message is open: the user
 * can still mark where they stopped taking it in (`mark`), back and forth,
 * until that message locks it. So Control is told what changed of an open
 * reply only once it is locked, and otherwise with the next message it gets
 * (`note`), never with a turn of its own: the moment it matters is when it
 * writes something next.
 *
 * Ranges are characters of each part as stored in the record — the words the
 * model wrote, without the "Kevin here." Control's speech puts in front.
 */

export type Delivery = 'spoken' | 'text'
export type ConsumedHow = 'read' | 'replayed' | 'summary'
/** How the user's message came: typed in the transcript, or spoken. See `settle`. */
export type Via = 'typed' | 'spoken'

/** Characters `[from, to)`. */
type Range = readonly [number, number]

interface Tracked {
  texts: string[]
  delivery: Delivery
  /** What of each part the user has not taken in waits for them, rather than being lost. */
  waiting: boolean
  /** What the user has taken in of each part. */
  consumed: Range[][]
  /**
   * What Control believes they have of each part; undefined for all of it,
   * which is what it assumes of any reply until it is told otherwise.
   */
  believed: Range[][] | undefined
}

/** A reply's taken-in prefix of each part, for the record's `heard` lines. */
export interface HeardMark { at: number; lengths: number[] }
/** A range newly taken in, for the record's `consumed` lines. */
export interface TakenRange { at: number; part: number; from: number; to: number }

/** Replies followed, newest kept: older ones are long past mattering to the next turn. */
const KEEP_REPLIES = 40
/** The most of any one stretch of words quoted back to the model. */
const QUOTE_CHARS = 240
/** How much of what the user did take in is quoted, to show the model where they stopped. */
const STOPPED_AT_CHARS = 80

export class ConsumptionLedger {
  /** By where each reply is in the record; insertion order is record order. */
  private readonly replies = new Map<number, Tracked>()
  /** Where the user's last message is in the record: replies after it are open. */
  private lastMessageAt = -1

  /** A reply said (`spoken`, taken in unless `heard` says otherwise) or written to a muted device (`text`, waiting to be read). */
  delivered(at: number, texts: readonly string[], delivery: Delivery): void {
    this.replies.set(at, {
      texts: [...texts],
      delivery,
      waiting: delivery === 'text',
      consumed: texts.map(text => delivery === 'spoken' ? [[0, text.length] as const] : []),
      believed: undefined,
    })
    while (this.replies.size > KEEP_REPLIES) this.replies.delete(this.replies.keys().next().value!)
  }

  /**
   * The reply at `at` was cut off, `lengths[i]` characters into part `i`.
   * Control is told so at once, by the note `noteInterruption` writes, so it
   * believes exactly that much. `waiting` when the rest is still the user's to
   * take in — they muted Control mid-reply, or were not there to hear it.
   */
  heard(at: number, lengths: readonly number[], waiting = false): void {
    const reply = this.replies.get(at)
    if (!reply) return
    reply.consumed = prefixes(reply.texts, lengths)
    reply.believed = clone(reply.consumed)
    reply.waiting = waiting
  }

  /**
   * The user marked where they stopped taking in what Control has said since
   * their last message: up to `char` characters into part `part` of the reply
   * at `at`. Everything open before that point counts as taken in, everything
   * after as lost. Returns the replies whose state changed, for the record, or
   * undefined if `at` is not open. Control is told once the turn is locked.
   */
  mark(at: number, part: number, char: number): HeardMark[] | undefined {
    const open = this.open()
    const target = open.find(([replyAt]) => replyAt === at)?.[1]
    if (!target || part < 0 || part >= target.texts.length) return undefined
    const marks: HeardMark[] = []
    for (const [replyAt, reply] of open) {
      const lengths = reply.texts.map((text, i) =>
        replyAt < at || (replyAt === at && i < part) ? text.length
          : replyAt === at && i === part ? Math.max(0, Math.min(text.length, char))
          : 0)
      const consumed = prefixes(reply.texts, lengths)
      if (!reply.waiting && same(consumed, reply.consumed)) continue
      reply.consumed = consumed
      reply.waiting = false
      marks.push({ at: replyAt, lengths })
    }
    return marks
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

  /** The user marked everything waiting as read. Returns what that took in, for the record. */
  readAll(): TakenRange[] {
    const taken: TakenRange[] = []
    for (const [at, reply] of this.replies) {
      if (!reply.waiting) continue
      reply.texts.forEach((text, part) => {
        for (const [from, to] of subtract([[0, text.length]], reply.consumed[part])) {
          this.consume(at, part, from, to)
          taken.push({ at, part, from, to })
        }
      })
    }
    return taken
  }

  /**
   * The user's message at `at` in the record locks everything said before it.
   * What was waiting is settled by how the message came: typed in the
   * transcript, the user was reading it there, so it was read; spoken, it was
   * not, and is lost. Words lost before — talked over, or marked — stay lost.
   * Returns what changed, for the record.
   */
  settle(via: Via, at: number): { read: TakenRange[]; lost: HeardMark[] } {
    this.lastMessageAt = at
    if (via === 'typed') return { read: this.readAll(), lost: [] }
    const lost: HeardMark[] = []
    for (const [replyAt, reply] of this.replies) {
      if (!reply.waiting) continue
      reply.waiting = false
      if (complete(reply)) continue
      const lengths = reply.texts.map((_, i) => covered(reply.consumed[i]))
      reply.consumed = prefixes(reply.texts, lengths)
      lost.push({ at: replyAt, lengths })
    }
    return { read: [], lost }
  }

  /** Replies with words waiting for the user, and where the oldest is. */
  unread(): { count: number; first?: number } {
    const unread = [...this.replies].filter(([, reply]) => reply.waiting && !complete(reply))
    return { count: unread.length, ...(unread.length ? { first: unread[0][0] } : {}) }
  }

  /** What is still waiting to be taken in, part by part, for a catch-up to take in. */
  unreadParts(): Array<{ at: number; part: number; from: number; to: number; text: string }> {
    const parts: Array<{ at: number; part: number; from: number; to: number; text: string }> = []
    for (const [at, reply] of this.replies) {
      if (!reply.waiting) continue
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
   * replies written to the user that they have not read, words it believes
   * were taken in that were not, and words it was told went unheard that have
   * been taken in since. Telling it brings its belief up to date, so each
   * change is told once. What the user marks of an open reply waits for the
   * turn to be locked, unless `all`: the server is going, and the next one
   * cannot tell what of the record its predecessor told.
   */
  note(all = false): string | undefined {
    const unread: string[] = []
    const neverRead: string[] = []
    const stopped: Array<{ before: string; lost: string }> = []
    const since: string[] = []
    for (const [at, reply] of this.replies) {
      const open = at > this.lastMessageAt && !all
      if (reply.believed === undefined && reply.delivery === 'text' && !complete(reply)) {
        if (reply.waiting) {
          // Written, and Control was never told it was not read.
          unread.push(quote(reply.texts.join(' ')))
          reply.believed = clone(reply.consumed)
          continue
        }
        if (!open && reply.consumed.every(part => part.length === 0)) {
          neverRead.push(quote(reply.texts.join(' ')))
          reply.believed = clone(reply.consumed)
          continue
        }
      }
      if (open) continue
      const believed = reply.believed ?? reply.texts.map(text => [[0, text.length] as const])
      const lost = untaken(reply, believed)
      if (lost) stopped.push({ before: stoppedAt(reply, believed), lost })
      const gained = reply.texts.flatMap((text, i) =>
        subtract(reply.consumed[i], believed[i]).map(([from, to]) => text.slice(from, to).trim()))
        .filter(Boolean)
      if (gained.length) since.push(quote(gained.join(' … ')))
      reply.believed = complete(reply) ? undefined : clone(reply.consumed)
    }
    const notes: string[] = []
    if (unread.length) {
      notes.push(`${unread.length === 1 ? 'A reply of yours was' : `${unread.length} replies of yours were`} written to the user rather than spoken, and they have not read ${unread.length === 1 ? 'it' : 'them'} yet: ${unread.join('; ')}. ` +
        'Do not assume they know what it says; if you act on any of it, say so when you report what you did.')
    }
    if (neverRead.length) {
      notes.push(`${neverRead.length === 1 ? 'A reply of yours was' : `${neverRead.length} replies of yours were`} written to the user rather than spoken, and they spoke again without reading ${neverRead.length === 1 ? 'it' : 'them'}: ${neverRead.join('; ')}. ` +
        'Do not assume they know what it says; if it still matters, tell them.')
    }
    if (stopped.length) {
      const [first] = stopped
      const where = first.before ? `They stopped taking in your words after "${first.before}"` : 'They took in none of your last words'
      notes.push(`${where}, and cut in there: they did not take in ${quote(stopped.map(entry => entry.lost).join(' … '))}. ` +
        'What they say next answers what came before that point: a question in what they missed is still unasked. ' +
        'If what they missed still matters, tell them, or add it to your backlog if it would pull them off the topic.')
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
   * notes the last server carried over (`note(true)`), so it believes what
   * was taken in.
   */
  restore(entries: readonly ControlTranscriptEntry[]): void {
    for (const entry of entries) {
      if (entry.kind === 'reply') this.delivered(entry.offset, entry.parts.map(part => part.text), entry.delivery ?? 'spoken')
      else if (entry.kind === 'heard') this.heard(entry.of, entry.parts, entry.unread === true)
      else if (entry.kind === 'consumed') this.consume(entry.of, entry.part, entry.from, entry.to)
      else if (entry.kind === 'user') this.lastMessageAt = entry.offset
    }
    for (const reply of this.replies.values()) reply.believed = complete(reply) ? undefined : clone(reply.consumed)
  }

  /** Replies said since the user's last message, oldest first. */
  private open(): Array<[number, Tracked]> {
    return [...this.replies].filter(([at]) => at > this.lastMessageAt)
  }
}

/** Whether `ranges` (what was consumed, by default) covers every part whole. */
function complete(reply: Tracked, ranges: Range[][] = reply.consumed): boolean {
  return reply.texts.every((text, i) => subtract([[0, text.length]], ranges[i]).length === 0)
}

/** Each part taken in from its start, `lengths[i]` characters of part `i`. */
function prefixes(texts: readonly string[], lengths: readonly number[]): Range[][] {
  return texts.map((text, i) => {
    const length = Math.min(text.length, lengths[i] ?? 0)
    return length > 0 ? [[0, length] as const] : []
  })
}

/** How far `ranges` reach unbroken from the start. */
function covered(ranges: readonly Range[]): number {
  const first = merge(ranges)[0]
  return first && first[0] === 0 ? first[1] : 0
}

/** What of `within` the user has not taken in, joined; empty if nothing. */
function untaken(reply: Tracked, within: Range[][]): string {
  return reply.texts.flatMap((text, i) =>
    subtract(within[i], reply.consumed[i]).map(([a, b]) => text.slice(a, b).trim()))
    .filter(Boolean).join(' … ')
}

/** The last words the user took in before the first they did not, for the model to place the cut. */
function stoppedAt(reply: Tracked, believed: Range[][]): string {
  for (let i = 0; i < reply.texts.length; i++) {
    const gap = subtract(believed[i], reply.consumed[i])[0]
    if (!gap) continue
    const before = [...reply.texts.slice(0, i), reply.texts[i].slice(0, gap[0])].join(' ').replace(/\s+/g, ' ').trim()
    return before.length > STOPPED_AT_CHARS ? `…${before.slice(-STOPPED_AT_CHARS).trimStart()}` : before
  }
  return ''
}

function same(a: Range[][], b: Range[][]): boolean {
  return a.length === b.length && a.every((part, i) => {
    const other = merge(b[i])
    const mine = merge(part)
    return mine.length === other.length && mine.every(([from, to], j) => from === other[j][0] && to === other[j][1])
  })
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
