import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'

/**
 * What the user thinks of songs, and which ones they have heard: the record
 * the like and dislike commands and the skip watcher's listening log keep, on
 * this Mac, for metrics on the user's taste and, later, for finding music.
 *
 * Two append-only JSON-lines files under ~/.spaceterm, a line per event, so
 * nothing is ever rewritten and a crash loses at most the line being written:
 *
 * - `spotify-taste.jsonl`: verdicts, `{"at", "verdict", "track"}`, where
 *   verdict is like, dislike or unblock. A song's verdict is its latest
 *   line: like, dislike, or none (never judged, or unblocked).
 * - `spotify-listens.jsonl`: one line per counted listen, `{"at", "track",
 *   "listenedMs", "device", "context"}`; see watcher.ts for what counts.
 *
 * `track` is `{"uri", "name", "artists", "album", "durationMs"}`. Every song
 * is in one of four states: heard and liked, heard and disliked, heard with no
 * verdict, or never heard (a verdict alone does not make it heard). The index
 * is built from the files on first use and kept up to date by this process's
 * own appends.
 */

export interface TrackInfo {
  uri: string
  name: string
  artists: string[]
  album?: string
  durationMs?: number
}

export type Verdict = 'like' | 'dislike' | 'unblock'

export interface VerdictEvent {
  at: string
  verdict: Verdict
  track: TrackInfo
  device?: string
  context?: string
}

export interface ListenEvent {
  at: string
  track: TrackInfo
  listenedMs: number
  device?: string
  context?: string
}

export interface TrackRecord {
  track: TrackInfo
  listens: number
  lastHeard?: string
  verdict?: 'like' | 'dislike'
}

/** Where the two files live, as lines of text: the seam tests replace. */
export interface TasteFiles {
  readLines(name: string): string[]
  appendLine(name: string, line: string): void
}

export const TASTE_FILE = 'spotify-taste.jsonl'
export const LISTENS_FILE = 'spotify-listens.jsonl'

export function diskTasteFiles(dir = SOCKET_DIR): TasteFiles {
  return {
    readLines(name) {
      const path = join(dir, name)
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim())
    },
    appendLine(name, line) {
      // One write per line, so concurrent appends cannot interleave within one.
      appendFileSync(join(dir, name), line + '\n', { mode: 0o600 })
    },
  }
}

function parse<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T
  } catch {
    return undefined
  }
}

export class TasteStore {
  private records: Map<string, TrackRecord> | undefined
  private listens: ListenEvent[] = []

  constructor(private readonly files: TasteFiles = diskTasteFiles(), private readonly now: () => number = Date.now) {}

  private index(): Map<string, TrackRecord> {
    if (this.records) return this.records
    const records = new Map<string, TrackRecord>()
    this.records = records
    for (const line of this.files.readLines(LISTENS_FILE)) {
      const e = parse<ListenEvent>(line)
      if (e?.track?.uri) this.applyListen(e)
    }
    for (const line of this.files.readLines(TASTE_FILE)) {
      const e = parse<VerdictEvent>(line)
      if (e?.track?.uri) this.applyVerdict(e)
    }
    return records
  }

  private record(track: TrackInfo): TrackRecord {
    const records = this.index()
    let r = records.get(track.uri)
    if (!r) {
      r = { track, listens: 0 }
      records.set(track.uri, r)
    } else {
      r.track = track
    }
    return r
  }

  private applyListen(e: ListenEvent): void {
    const r = this.record(e.track)
    r.listens++
    r.lastHeard = e.at
    this.listens.push(e)
  }

  private applyVerdict(e: VerdictEvent): void {
    const r = this.record(e.track)
    r.verdict = e.verdict === 'unblock' ? undefined : e.verdict
  }

  get(uri: string): TrackRecord | undefined {
    return this.index().get(uri)
  }

  isBlocked(uri: string | undefined): boolean {
    return !!uri && this.index().get(uri)?.verdict === 'dislike'
  }

  setVerdict(verdict: Verdict, track: TrackInfo, where: { device?: string; context?: string } = {}): void {
    const e: VerdictEvent = { at: new Date(this.now()).toISOString(), verdict, track, ...where }
    this.index()
    this.files.appendLine(TASTE_FILE, JSON.stringify(e))
    this.applyVerdict(e)
  }

  addListen(track: TrackInfo, listenedMs: number, where: { device?: string; context?: string } = {}): void {
    const e: ListenEvent = { at: new Date(this.now()).toISOString(), track, listenedMs: Math.round(listenedMs), ...where }
    this.index()
    this.files.appendLine(LISTENS_FILE, JSON.stringify(e))
    this.applyListen(e)
  }

  blocked(): TrackRecord[] {
    return [...this.index().values()].filter((r) => r.verdict === 'dislike')
  }

  /** Counted listens, newest first. */
  recentListens(count: number): ListenEvent[] {
    this.index()
    return this.listens.slice(-count).reverse()
  }

  all(): TrackRecord[] {
    return [...this.index().values()]
  }
}

/** A song's state in words, for status: "heard 3 times, liked". */
export function stateWords(r: TrackRecord | undefined): string {
  if (!r) return 'never heard'
  const heard = r.listens ? `heard ${r.listens} time${r.listens === 1 ? '' : 's'}` : 'never heard'
  const verdict = r.verdict === 'like' ? 'liked' : r.verdict === 'dislike' ? 'disliked (blocked)' : 'no verdict'
  return `${heard}, ${verdict}`
}
