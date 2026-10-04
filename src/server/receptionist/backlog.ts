/**
 * Control's backlog: things to talk to the user about later.
 *
 * The user can take one topic at a time. While Control and the user are
 * working through one, anything else — news from an agent, a reply of
 * Control's they cut off, a question they never answered, something Control
 * meant to do — goes here instead of into the conversation. Once the topic is
 * wrapped up, Control asks for the next item, and Jev, not Control, picks the
 * one that matters most now: the backlog's order is when things came up, not
 * how much they matter. When the user asks about something in particular,
 * Control describes it instead, and Jev finds every item about it, if any is.
 *
 * Kept on disk rather than in Control's session, which is compacted and
 * replaced: what Control set aside has to outlast what Control remembers.
 */
import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import type { JevRequest } from '../agent-search'
import { fileStore, type NameRegistryStore } from './name-registry'
import { ago } from './roster'

export const BACKLOG_FILE = path.join(SOCKET_DIR, 'receptionist', 'backlog.json')
/** The most items kept. Past it the oldest goes: a backlog this long is not being worked through. */
export const MAX_BACKLOG = 20
/** The most of one item kept, so a pasted transcript cannot crowd out the rest. */
export const MAX_ITEM_CHARS = 600
/** An agent whose prompt cache goes cold within this long is flagged to Jev as about to cost more. */
export const COLD_SOON_MS = 10 * 60_000

export interface BacklogItem {
  text: string
  /** Epoch ms. */
  addedAt: number
  /** The agents the item is about, by surface: whose prompt cache decides what waiting on it costs. */
  agents?: NodeId[]
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
  add(text: string, now = Date.now(), agents: readonly NodeId[] = []): BacklogItem[] {
    this.items.push({ text: text.slice(0, MAX_ITEM_CHARS), addedAt: now, ...(agents.length && { agents: [...agents] }) })
    const dropped = this.items.splice(0, Math.max(0, this.items.length - MAX_BACKLOG))
    this.save()
    return dropped
  }

  /** Remove and return the items at `indices`, oldest first. */
  take(indices: readonly number[]): BacklogItem[] {
    const taking = new Set(indices)
    const taken = this.items.filter((_, i) => taking.has(i))
    if (!taken.length) return []
    this.items = this.items.filter((_, i) => !taking.has(i))
    this.save()
    return taken
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
        typeof item?.text === 'string' && typeof item?.addedAt === 'number' &&
        (item.agents === undefined || (Array.isArray(item.agents) && item.agents.every((id: unknown) => typeof id === 'string')))).slice(-MAX_BACKLOG)
    } catch {
      // A corrupt file is an empty backlog, not a server that will not start.
    }
  }

  private save(): void {
    this.store.save(JSON.stringify({ items: this.items }))
  }
}

/** Everything Jev is shown to pick from the backlog. */
export interface BacklogContext {
  /** The recent conversation, oldest first. */
  conversation: string
  /**
   * Each item, oldest first, with how long ago it was added in words, and
   * what waiting costs: the prompt cache of each agent it is about, from
   * `cacheNote`, when known.
   */
  items: Array<{ text: string; age: string; cache?: string }>
  /** What the user asked about, as Control describes it, when it is looking for the items about one thing. */
  about?: string
}

/** Jev's probability at or above which an item counts as about what Control is looking for. */
export const RELEVANT_THRESHOLD = 0.5

const describeItem = (item: BacklogContext['items'][number]): string =>
  `${item.text} (set aside ${item.age}${item.cache ? `; ${item.cache}` : ''})`

/**
 * The question for Jev. Asked for the next item, one choice among them all:
 * only one is brought up. Asked `about` something, one yes-or-no per item:
 * any number of them may be about it, and every one that is comes off.
 * Keys are short indices, as in the agent search: billed tokens.
 */
export function jevBacklogRequest(ctx: BacklogContext): JevRequest {
  if (ctx.about !== undefined) {
    const questions: Record<string, unknown> = {}
    ctx.items.forEach((item, i) => {
      questions[`b${i}`] = {
        type: 'noul',
        instructions:
          'A voice receptionist set things aside to bring up with its user later, and the user has now asked about something ' +
          '(`recent_conversation`, described in `looking_for`). Is this item, which the receptionist set aside, part of what the user asked about? ' +
          `The item: ${describeItem(item)}`,
        criteria: {
          true: 'The item is about what the user asked about, so it belongs in the answer.',
          false: 'The item is about something else.',
        },
      }
    })
    return { state: { recent_conversation: ctx.conversation, looking_for: ctx.about }, questions }
  }
  const criteria: Record<string, string> = {}
  ctx.items.forEach((item, i) => { criteria[`b${i}`] = describeItem(item) })
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
          'and, when nothing else decides it, what has waited longest. Waiting also has a cost: an item may say its agent\'s prompt cache ' +
          'is about to go cold, after which continuing that agent is much more expensive. Between items that matter about as much, ' +
          'prefer the one whose agent goes cold soonest.',
        criteria,
      },
    },
  }
}

/**
 * Jev's probability for each item, in order — that it comes next, or that it
 * is about what Control is looking for — or undefined if the answer is not
 * there. An item Jev left out counts as zero.
 */
export function readBacklogJudgement(response: unknown, ctx: BacklogContext): number[] | undefined {
  const answers = (response as { answers?: Record<string, { probabilities?: unknown; noul?: unknown }> } | undefined)?.answers
  if (typeof answers !== 'object' || answers === null) return undefined
  const number = (value: unknown): number => typeof value === 'number' ? value : 0
  if (ctx.about !== undefined) {
    if (!ctx.items.some((_, i) => typeof answers[`b${i}`]?.noul === 'number')) return undefined
    return ctx.items.map((_, i) => number(answers[`b${i}`]?.noul))
  }
  const probabilities = answers.next?.probabilities
  if (typeof probabilities !== 'object' || probabilities === null) return undefined
  return ctx.items.map((_, i) => number((probabilities as Record<string, unknown>)[`b${i}`]))
}

/** Jev as the judge, through the `jev` CLI runner the agent search uses. */
export function jevBacklogJudge(runJev: (request: JevRequest) => Promise<unknown>): (ctx: BacklogContext) => Promise<number[]> {
  return async (ctx) => {
    const probabilities = readBacklogJudgement(await runJev(jevBacklogRequest(ctx)), ctx)
    if (!probabilities) throw new Error('Jev gave no probabilities')
    return probabilities
  }
}

/** Which items to take, by position, oldest first; none when nothing is about what Control is looking for. */
export type BacklogPick =
  | { indices: number[]; reason: 'only-one' }
  | { indices: number[]; reason: 'judged'; probabilities: number[] }
  | { indices: number[]; reason: 'judge-failed'; error: string }

/**
 * Which items to take. Asked for the next one: Jev's most probable, or the
 * oldest when there is nothing to choose between or Jev cannot say, since a
 * failure should lose only the judgement, never the user's place. Asked
 * `about` something: every item Jev finds is about it, which may be none, and
 * none when Jev cannot say, since handing Control the wrong items would have
 * it bring up the wrong things.
 */
export async function pickNext(ctx: BacklogContext, judge: (ctx: BacklogContext) => Promise<number[]>): Promise<BacklogPick> {
  const looking = ctx.about !== undefined
  if (!looking && ctx.items.length <= 1) return { indices: [0], reason: 'only-one' }
  try {
    const probabilities = await judge(ctx)
    if (looking) {
      return { indices: probabilities.flatMap((p, i) => p >= RELEVANT_THRESHOLD ? [i] : []), reason: 'judged', probabilities }
    }
    let index = 0
    probabilities.forEach((p, i) => { if (p > probabilities[index]) index = i })
    return { indices: [index], reason: 'judged', probabilities }
  } catch (err) {
    return { indices: looking ? [] : [0], reason: 'judge-failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * What waiting on an agent costs, for Jev: a warning when its prompt cache
 * goes cold within `COLD_SOON_MS`, how long it stays warm otherwise, and
 * nothing once it is cold, when waiting longer costs nothing more.
 */
export function cacheNote(agent: string, warmUntil: number, now: number): string | undefined {
  const left = warmUntil - now
  if (left <= 0) return undefined
  if (left <= COLD_SOON_MS) {
    return `WARNING: ${agent}'s prompt cache goes cold in ${ago(left)}, and continuing it after that costs much more`
  }
  return `${agent}'s prompt cache stays warm for ${ago(left)} more`
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
