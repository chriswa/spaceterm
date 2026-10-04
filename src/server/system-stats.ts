import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { SystemStatsSegment, SystemStatsSnapshot, SystemStatsWidget } from '../shared/system-stats'
import { serverLog } from './server-log'

/**
 * The Mac's system monitor from mini-stats (~/mini-stats), for the phone.
 *
 * mini-stats writes what its menu-bar item draws to a JSON file within a
 * second of any change, and rewrites it every 15 s regardless (its
 * `MenuBarExport.swift`). Reading a small file is cheap, but the readings
 * change every second, so this polls only while a phone is watching.
 */

/** How often to read while someone is watching. */
export const POLL_MS = 2_000
/** mini-stats rewrites every 15 s even when idle: a file this old means it is not running. */
export const STALE_AFTER_MS = 45_000

const EXPORT_PATH = join(homedir(), '.mini-stats', 'menubar.json')

// ─── mini-stats' export (src: Kit/MenuBarExport.swift) ───

interface ExportFile {
  version: number
  updatedAt: string
  spacing: number
  widgets: SystemStatsWidget[]
}

/** Two places is finer than a phone draws; it spares sending noise. */
const round = (v: number): number => Math.round(v * 100) / 100

const segment = (s: SystemStatsSegment): SystemStatsSegment => ({ value: round(s.value), color: s.color })

/**
 * The snapshot an export describes, or null if it is stale, or from a version
 * of mini-stats this does not understand.
 */
export function systemStatsFrom(file: ExportFile, now: number): SystemStatsSnapshot | null {
  if (file.version !== 1) return null
  const at = Date.parse(file.updatedAt)
  if (!Number.isFinite(at) || now - at > STALE_AFTER_MS) return null
  const widgets: SystemStatsWidget[] = []
  for (const w of file.widgets) {
    if (w.kind === 'bars') widgets.push({ ...w, bars: w.bars.map((bar) => bar.map(segment)) })
    else if (w.kind === 'battery') widgets.push(w.level === undefined ? w : { ...w, level: round(w.level) })
  }
  return { spacing: file.spacing, widgets }
}

export interface SystemStatsDeps {
  /** The export's contents, or null when there is none. */
  read(): Promise<string | null>
  now(): number
  schedule(fn: () => void, ms: number): () => void
}

const REAL_DEPS: SystemStatsDeps = {
  read: () => readFile(EXPORT_PATH, 'utf8').catch(() => null),
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref()
    return () => clearTimeout(timer)
  }
}

export class SystemStatsWatcher {
  private snapshot: SystemStatsSnapshot | null = null
  private cancel: (() => void) | null = null
  private watched = false
  private polling = false

  constructor(
    /** A snapshot that differs from the last one; null when mini-stats has stopped. */
    private readonly onChange: (snapshot: SystemStatsSnapshot | null) => void,
    private readonly deps: SystemStatsDeps = REAL_DEPS
  ) {}

  current(): SystemStatsSnapshot | null {
    return this.snapshot
  }

  /** Poll while someone is watching; stop when no one is. */
  setWatched(watched: boolean): void {
    if (watched === this.watched) return
    this.watched = watched
    if (!watched) {
      this.cancel?.()
      this.cancel = null
      // Kept, it would greet the next watcher with a reading from whenever this one left.
      this.snapshot = null
    } else if (!this.polling) {
      void this.poll()
    }
  }

  /** One read, then the next one scheduled if still watched. Exposed for tests. */
  async poll(): Promise<void> {
    this.cancel = null
    this.polling = true
    let next: SystemStatsSnapshot | null = null
    const raw = await this.deps.read()
    if (raw !== null) {
      try {
        next = systemStatsFrom(JSON.parse(raw) as ExportFile, this.deps.now())
      } catch (err) {
        serverLog(`[system-stats] unreadable export: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.polling = false
    if (!this.watched) return
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) {
      this.snapshot = next
      this.onChange(next)
    }
    this.cancel = this.deps.schedule(() => void this.poll(), POLL_MS)
  }
}
