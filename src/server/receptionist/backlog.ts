/**
 * Control's backlog: things to talk to the user about later.
 *
 * The user can take one topic at a time. While Control and the user are
 * working through one, anything else — news from an agent, a reply of
 * Control's they cut off, a question they never answered, something Control
 * meant to do — goes here instead of into the conversation. Once the topic is
 * wrapped up, Control asks for the next item, and Jev, not Control, picks the
 * one that matters most now: the backlog's order is when things came up, not
 * how much they matter.
 *
 * Kept on disk rather than in Control's session, which is compacted and
 * replaced: what Control set aside has to outlast what Control remembers.
 */
import * as path from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import type { JevRequest } from '../agent-search'
import { fileStore, type NameRegistryStore } from './name-registry'

export const BACKLOG_FILE = path.join(SOCKET_DIR, 'receptionist', 'backlog.json')
/** The most items kept. Past it the oldest goes: a backlog this long is not being worked through. */
export const MAX_BACKLOG = 20
/** The most of one item kept, so a pasted transcript cannot crowd out the rest. */
export const MAX_ITEM_CHARS = 600

export interface BacklogItem {
  text: string
  /** Epoch ms. */
  addedAt: number
}

export class Backlog {
  private items: BacklogItem[] = []
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(BACKLOG_FILE)
    this.load()
  }

  get size(): number {
    return this.items.length
  }

  /** Every item, oldest first. */
  all(): readonly BacklogItem[] {
    return this.items
  }

  /** Add an item; returns any the cap pushed out, oldest first. */
  add(text: string, now = Date.now()): BacklogItem[] {
    this.items.push({ text: text.slice(0, MAX_ITEM_CHARS), addedAt: now })
    const dropped = this.items.splice(0, Math.max(0, this.items.length - MAX_BACKLOG))
    this.save()
    return dropped
  }

  /** Remove and return the item at `index`. */
  take(index: number): BacklogItem | undefined {
    const [item] = this.items.splice(index, 1)
    if (item) this.save()
    return item
  }

  /** Put back items taken for a reply nobody heard, where they were by age. */
  restore(items: readonly BacklogItem[]): void {
    if (!items.length) return
    this.items = [...this.items, ...items].sort((a, b) => a.addedAt - b.addedAt).slice(-MAX_BACKLOG)
    this.save()
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { items?: unknown }
      if (!Array.isArray(parsed.items)) return
      this.items = parsed.items.filter((item): item is BacklogItem =>
        typeof item?.text === 'string' && typeof item?.addedAt === 'number').slice(-MAX_BACKLOG)
    } catch {
      // A corrupt file is an empty backlog, not a server that will not start.
    }
  }

  private save(): void {
    this.store.save(JSON.stringify({ items: this.items }))
  }
}

/** Everything Jev is shown to pick the next item. */
export interface BacklogContext {
  /** The recent conversation, oldest first. */
  conversation: string
  /** Each item, oldest first, with how long ago it was added in words. */
  items: Array<{ text: string; age: string }>
}

export function jevBacklogRequest(ctx: BacklogContext): JevRequest {
  // Option keys are short indices, as in the agent search: billed tokens.
  const criteria: Record<string, string> = {}
  ctx.items.forEach((item, i) => { criteria[`b${i}`] = `${item.text} (set aside ${item.age})` })
  return {
    state: { recent_conversation: ctx.conversation },
    questions: {
      next: {
        type: 'choice',
        instructions:
          'A voice receptionist helps a user who runs many coding agents, and who can only take one topic at a time. ' +
          'It set things aside while they talked about something else, and that topic is now wrapped up (`recent_conversation`). ' +
          'Which one item should it bring up next? Each option is one thing it set aside. Prefer what is most important to the user now: ' +
          'an agent waiting on the user, a problem, or news they asked for, over routine news; something the conversation just touched on; ' +
          'and, when nothing else decides it, what has waited longest.',
        criteria,
      },
    },
  }
}

/** Jev's probability for each item, in order, or undefined if the answer is not there. */
export function readBacklogProbabilities(response: unknown, count: number): number[] | undefined {
  const probabilities = (response as { answers?: { next?: { probabilities?: unknown } } } | undefined)?.answers?.next?.probabilities
  if (typeof probabilities !== 'object' || probabilities === null) return undefined
  const byKey = probabilities as Record<string, unknown>
  return Array.from({ length: count }, (_, i) => {
    const p = byKey[`b${i}`]
    return typeof p === 'number' ? p : 0
  })
}

/** Jev as the judge, through the `jev` CLI runner the agent search uses. */
export function jevBacklogJudge(runJev: (request: JevRequest) => Promise<unknown>): (ctx: BacklogContext) => Promise<number[]> {
  return async (ctx) => {
    const probabilities = readBacklogProbabilities(await runJev(jevBacklogRequest(ctx)), ctx.items.length)
    if (!probabilities) throw new Error('Jev gave no probabilities')
    return probabilities
  }
}

export type BacklogPick =
  | { index: number; reason: 'only-one' }
  | { index: number; reason: 'judged'; probabilities: number[] }
  | { index: number; reason: 'judge-failed'; error: string }

/**
 * Which item comes next: Jev's most probable, or the oldest when there is
 * nothing to choose between or Jev cannot say. A failure never loses the
 * user's place; it only loses the judgement.
 */
export async function pickNext(
  ctx: BacklogContext, judge: (ctx: BacklogContext) => Promise<number[]>,
): Promise<BacklogPick> {
  if (ctx.items.length <= 1) return { index: 0, reason: 'only-one' }
  try {
    const probabilities = await judge(ctx)
    let index = 0
    probabilities.forEach((p, i) => { if (p > probabilities[index]) index = i })
    return { index, reason: 'judged', probabilities }
  } catch (err) {
    return { index: 0, reason: 'judge-failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/** How long ago, in words a model reads easily. */
export function ageWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
