/**
 * What Control has yet to tell or answer, kept on disk.
 *
 * Everything here used to wait in memory, and a server restart — which the
 * user is told to do often, by the very agents being watched — threw it away:
 *
 * - News for Control's next turn. An agent stopping, ending, or answering a
 *   side question becomes an event, and the watch that caught it is gone the
 *   moment it fires: "tell me when Dean is done", and then nothing, ever.
 * - What a turn took. A turn takes the waiting news and the user's words, and
 *   only once it is over have they been dealt with. Until then they are held
 *   here as the turn's, so a server that stops mid-turn leaves them to the
 *   next one: told twice is better than never told, and words answered twice
 *   better than never answered.
 * - What the user missed while away: news Control acted on while nobody could
 *   hear, to be told when they are back. See `ReturnNews`.
 * - Side questions not yet answered. The next server asks them again.
 */
import * as path from 'path'
import type { NodeId } from '../../shared/ids'
import { SOCKET_DIR } from '../../shared/protocol'
import { serverLog } from '../server-log'
import { fileStore, type NameRegistryStore } from './name-registry'
import { mergeNews, type ReceptionistEvent, type ReturnNews } from './prompt'

export const PENDING_NEWS_FILE = path.join(SOCKET_DIR, 'receptionist', 'pending-news.json')

const KINDS: ReadonlySet<ReceptionistEvent['kind']> = new Set(['agent-stopped', 'agent-ended', 'agent-answer', 'agent-answer-failed'])

/** Which turn took something: settling a turn that has been superseded must not drop what its successor took. */
export type Taking = object

/** What the user missed while away, before and after it is handed to the turn that tells them. */
export interface Away {
  missed?: ReturnNews
  returnNews?: ReturnNews
}

/** A side question asked and not yet answered. `tries` counts the servers that have asked it. */
export interface Asking {
  id: string
  nodeId: NodeId
  question: string
  ended: boolean
  tries: number
}

interface Taken {
  by: Taking
  events: ReceptionistEvent[]
  words?: string
  /** What the user missed while away, being told by this turn. */
  news?: ReturnNews
}

export class PendingNews {
  private waiting: ReceptionistEvent[] = []
  private taken: Taken | undefined
  /** The words of a turn the last server never finished: for the next turn to say again. */
  private leftWords: string | undefined
  private away: Away = {}
  private asking: Asking[] = []
  private readonly store: NameRegistryStore

  constructor(deps: { store?: NameRegistryStore } = {}) {
    this.store = deps.store ?? fileStore(PENDING_NEWS_FILE)
    this.load()
  }

  get length(): number {
    return this.waiting.length
  }

  /** The news waiting, oldest first. */
  all(): ReceptionistEvent[] {
    return [...this.waiting]
  }

  some(test: (event: ReceptionistEvent) => boolean): boolean {
    return this.waiting.some(test)
  }

  push(event: ReceptionistEvent): void {
    this.waiting.push(event)
    this.save()
  }

  /** Drop the waiting news that matches. */
  drop(test: (event: ReceptionistEvent) => boolean): void {
    const kept = this.waiting.filter(event => !test(event))
    if (kept.length === this.waiting.length) return
    this.waiting = kept
    this.save()
  }

  /**
   * A turn takes everything waiting, with the user's words if it has any. They
   * stay on disk as that turn's until `told`.
   */
  take(by: Taking, words?: string, news?: ReturnNews): ReceptionistEvent[] {
    const events = this.waiting
    this.waiting = []
    // The words a last server left are in `words` now, if there were any: see `takeLeftWords`.
    this.leftWords = undefined
    const earlier = this.taken
    const allWords = [earlier?.words, words].filter((w): w is string => Boolean(w))
    const allNews = mergeNews(earlier?.news, news)
    this.taken = {
      by,
      events: [...(earlier?.events ?? []), ...events],
      ...(allWords.length ? { words: allWords.join(' ') } : {}),
      ...(allNews ? { news: allNews } : {}),
    }
    this.save()
    return events
  }

  /** The turn that took them is over: what it took was told, or failed past retelling. */
  told(by: Taking): void {
    if (this.taken?.by !== by) return
    this.taken = undefined
    this.save()
  }

  /** News a turn took and never told goes back, ahead of whatever came since. */
  requeue(events: readonly ReceptionistEvent[], by: Taking): void {
    if (this.taken?.by === by) this.taken = undefined
    this.waiting = [...events, ...this.waiting]
    this.save()
  }

  /**
   * The user's words from a turn the last server never finished, for the next
   * turn to say again. They stay on disk until a turn takes them.
   */
  takeLeftWords(): string | undefined {
    return this.leftWords
  }

  /** What the user missed while away, as the last server left it. */
  awayNews(): Away {
    return { ...this.away }
  }

  keepAway(away: Away): void {
    this.away = {
      ...(away.missed ? { missed: away.missed } : {}),
      ...(away.returnNews ? { returnNews: away.returnNews } : {}),
    }
    this.save()
  }

  /** The side questions the last server asked and never had answered. They are this server's to ask again. */
  unanswered(): Asking[] {
    const asking = this.asking
    this.asking = []
    this.save()
    return asking
  }

  asked(question: Asking): void {
    this.asking = [...this.asking.filter(q => q.id !== question.id), question]
    this.save()
  }

  /** Its answer, or its failure, is now news: see `push`. */
  answered(id: string): void {
    const kept = this.asking.filter(q => q.id !== id)
    if (kept.length === this.asking.length) return
    this.asking = kept
    this.save()
  }

  private load(): void {
    const raw = this.store.load()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as {
        waiting?: unknown; taken?: unknown; takenWords?: unknown; takenNews?: unknown; leftWords?: unknown; away?: Away; asking?: unknown
      }
      // A turn the last server never finished: its news first, since it came first.
      this.waiting = [...asEvents(parsed.taken), ...asEvents(parsed.waiting)]
      const words = [parsed.leftWords, parsed.takenWords].filter((w): w is string => typeof w === 'string' && w !== '')
      if (words.length) this.leftWords = words.join(' ')
      const takenNews = isNews(parsed.takenNews) ? parsed.takenNews : undefined
      const returnNews = isNews(parsed.away?.returnNews) ? parsed.away.returnNews : undefined
      const back = mergeNews(takenNews, returnNews)
      this.away = {
        ...(isNews(parsed.away?.missed) ? { missed: parsed.away.missed } : {}),
        ...(back ? { returnNews: back } : {}),
      }
      this.asking = Array.isArray(parsed.asking) ? parsed.asking.filter(isAsking) : []
      this.save()
    } catch {
      // A corrupt file is no news, not a server that will not start.
    }
  }

  /** Best-effort: called from state changes, where a failed write must not throw. */
  private save(): void {
    try {
      this.store.save(JSON.stringify({
        waiting: this.waiting,
        taken: this.taken?.events ?? [],
        ...(this.taken?.words !== undefined ? { takenWords: this.taken.words } : {}),
        ...(this.taken?.news ? { takenNews: this.taken.news } : {}),
        ...(this.leftWords !== undefined ? { leftWords: this.leftWords } : {}),
        away: this.away,
        asking: this.asking,
      }))
    } catch (err) {
      serverLog(`[receptionist] failed to save pending news: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

function asEvents(value: unknown): ReceptionistEvent[] {
  if (!Array.isArray(value)) return []
  return value.filter(isEvent)
}

function isEvent(event: unknown): event is ReceptionistEvent {
  return typeof event === 'object' && event !== null && KINDS.has((event as { kind?: unknown }).kind as ReceptionistEvent['kind'])
    && typeof (event as { agent?: unknown }).agent === 'string'
}

function isNews(value: unknown): value is ReturnNews {
  if (typeof value !== 'object' || value === null) return false
  const news = value as Partial<ReturnNews>
  return Array.isArray(news.events) && news.events.every(isEvent) && typeof news.unheard === 'boolean'
}

function isAsking(value: unknown): value is Asking {
  if (typeof value !== 'object' || value === null) return false
  const q = value as Partial<Asking>
  return typeof q.id === 'string' && typeof q.nodeId === 'string' && typeof q.question === 'string'
    && typeof q.ended === 'boolean' && typeof q.tries === 'number'
}
