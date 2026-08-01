import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { SOCKET_DIR } from '../shared/protocol'
import type { GhRateLimitData } from '../shared/protocol'
import { RingBuffer } from './ring-buffer'

/**
 * Polls GitHub's GraphQL rate limit and keeps a short history for the toolbar
 * sparkline.
 *
 * MODDING.md names this the best first mod: it is a poller shelling out to a
 * CLI, a ring buffer, one protocol message, one store and one widget — small
 * enough to finish, complete enough to prove the API. Pulling it out of
 * index.ts into a self-contained module with its own seam is the step before
 * that, and the same shape a mod would take.
 *
 * Everything it touches outside its own process is behind `GhRateLimitDeps`.
 */

/** Poll cadence. Also the ring buffer's slot width. */
export const GH_RATE_LIMIT_POLL_MS = 60_000

/**
 * Slot width in minutes, sent to the client so sparkline tooltips can show a
 * correct per-minute rate rather than assuming the cadence.
 */
export const GH_RATE_LIMIT_SLOT_MINUTES = GH_RATE_LIMIT_POLL_MS / 60_000

const USAGE_LOG_DIR = path.join(SOCKET_DIR, 'usage-logs')
const GH_RATE_LIMIT_LOG_FILE = path.join(USAGE_LOG_DIR, 'gh_rate_limit.jsonl')
const GH_RATE_LIMIT_CACHE_FILE = path.join(SOCKET_DIR, 'gh-rate-limit-cache.json')

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

export interface GhRateLimitDeps {
  /** Ask GitHub for the current rate limit. Rejects when `gh` is missing or fails. */
  fetch(): Promise<GhRateLimitData>
  /** Last reading from a previous run, so a fresh client sees something immediately. */
  readCache(): GhRateLimitData | undefined
  writeCache(data: GhRateLimitData): void
  /** Append one reading to the history log. Best-effort. */
  appendLog(entry: Record<string, unknown>): void
  /** Path of the history log, for seeding the ring buffer at startup. */
  readonly logPath: string
  scheduleInterval(fn: () => void, ms: number): CancelScheduled
}

/**
 * Parse `gh api graphql` output into a reading.
 *
 * Separate from the fetch so the response shape — which is someone else's API
 * and the thing most likely to change under us — can be tested directly.
 */
export function parseGhRateLimitResponse(stdout: string): GhRateLimitData {
  const parsed = JSON.parse(stdout)
  const rl = parsed?.data?.rateLimit
  if (
    !rl ||
    typeof rl.limit !== 'number' ||
    typeof rl.remaining !== 'number' ||
    typeof rl.resetAt !== 'string'
  ) {
    throw new Error('Unexpected gh rate limit response shape')
  }
  // The API reports what is left; the sparkline plots what has been consumed.
  return { limit: rl.limit, used: rl.limit - rl.remaining, resetAt: rl.resetAt }
}

/** True when a parsed cache file holds a usable reading. */
export function isGhRateLimitData(value: unknown): value is GhRateLimitData {
  if (!value || typeof value !== 'object') return false
  const d = value as Record<string, unknown>
  return typeof d.limit === 'number' && typeof d.used === 'number' && typeof d.resetAt === 'string'
}

export const REAL_GH_RATE_LIMIT_DEPS: GhRateLimitDeps = {
  fetch() {
    return new Promise((resolve, reject) => {
      execFile(
        'gh',
        ['api', 'graphql', '-f', 'query={ rateLimit { limit remaining resetAt } }'],
        { timeout: 10_000 },
        (err, stdout) => {
          if (err) return reject(new Error(`gh api failed: ${err.message}`))
          try {
            resolve(parseGhRateLimitResponse(stdout))
          } catch (e: any) {
            reject(new Error(`Failed to parse gh response: ${e.message}`))
          }
        }
      )
    })
  },

  readCache() {
    try {
      if (!fs.existsSync(GH_RATE_LIMIT_CACHE_FILE)) return undefined
      const data = JSON.parse(fs.readFileSync(GH_RATE_LIMIT_CACHE_FILE, 'utf8'))
      return isGhRateLimitData(data) ? data : undefined
    } catch (err: any) {
      console.error(`[gh-rate-limit] Failed to load cache: ${err.message}`)
      return undefined
    }
  },

  writeCache(data) {
    fs.writeFile(GH_RATE_LIMIT_CACHE_FILE, JSON.stringify(data), (err) => {
      if (err) console.error(`[gh-rate-limit] Failed to save cache: ${err.message}`)
    })
  },

  appendLog(entry) {
    fs.mkdirSync(USAGE_LOG_DIR, { recursive: true })
    fs.appendFile(GH_RATE_LIMIT_LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
      if (err) console.error(`[gh-rate-limit] Failed to write log: ${err.message}`)
    })
  },

  logPath: GH_RATE_LIMIT_LOG_FILE,

  scheduleInterval(fn, ms) {
    const timer = setInterval(fn, ms)
    return () => clearInterval(timer)
  }
}

/** What a client needs to draw the sparkline. */
export interface GhRateLimitReport {
  data: GhRateLimitData
  usedHistory: (number | null)[]
  slotMinutes: number
}

export type GhRateLimitCallback = (report: GhRateLimitReport) => void

export class GhRateLimitPoller {
  private history = new RingBuffer('gh-rate-limit', GH_RATE_LIMIT_POLL_MS)
  private latest: GhRateLimitData | undefined
  private cancelInterval: CancelScheduled | null = null

  constructor(
    private readonly onReading: GhRateLimitCallback,
    private readonly deps: GhRateLimitDeps = REAL_GH_RATE_LIMIT_DEPS
  ) {}

  /**
   * Seed from the previous run's cache and log, then poll immediately and on a
   * timer. Returns the initial poll so a caller can await it if it wants to.
   */
  start(): Promise<void> {
    this.latest = this.deps.readCache()
    if (this.latest) {
      console.log(`[gh-rate-limit] Loaded cached data (${this.latest.used}/${this.latest.limit})`)
    }
    this.history.seedFromLog(this.deps.logPath, 'used')

    this.cancelInterval = this.deps.scheduleInterval(() => { void this.poll() }, GH_RATE_LIMIT_POLL_MS)
    return this.poll()
  }

  /**
   * The most recent reading, or undefined before the first successful poll.
   * Sent to a connecting client so it does not wait a minute for a sparkline.
   */
  current(now: number = Date.now()): GhRateLimitReport | undefined {
    if (!this.latest) return undefined
    return { data: this.latest, usedHistory: this.history.build(now), slotMinutes: GH_RATE_LIMIT_SLOT_MINUTES }
  }

  async poll(now: number = Date.now()): Promise<void> {
    let data: GhRateLimitData
    try {
      data = await this.deps.fetch()
    } catch (err: any) {
      // `gh` missing or unauthenticated is the common case, and is not fatal —
      // the sparkline simply has nothing to draw.
      console.error(`[gh-rate-limit] Fetch failed: ${err.message}`)
      return
    }

    this.latest = data
    this.deps.writeCache(data)
    this.history.record(data.used, now)
    this.onReading({
      data,
      // Same `now` the reading was recorded at: build() windows the buffer
      // against the clock, so reading and building at different times drops
      // the slot that was just written.
      usedHistory: this.history.build(now),
      slotMinutes: GH_RATE_LIMIT_SLOT_MINUTES
    })
    console.log(`[gh-rate-limit] ${data.used}/${data.limit}, resets ${data.resetAt}`)

    this.deps.appendLog({
      timestamp: new Date(now).toISOString(),
      used: data.used,
      limit: data.limit,
      resetAt: data.resetAt
    })
  }

  dispose(): void {
    this.cancelInterval?.()
    this.cancelInterval = null
  }
}
