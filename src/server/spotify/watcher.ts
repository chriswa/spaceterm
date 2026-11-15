import { execFile } from 'child_process'
import { SignInNeeded } from './auth'
import { SpotifyApiError, type Item, type PlaybackState } from './index'
import type { TasteStore, TrackInfo } from './taste'

/**
 * The skip watcher: keeps disliked songs from playing, and logs the songs the
 * user actually listens to. One per server, started from src/server/index.ts.
 *
 * Spotify cannot tell us when a song changes, so the watcher looks, but as
 * seldom as it can rather than every second:
 *
 * - While playing, the next look is when the song is due to end, plus 100 ms,
 *   but never more than PLAYING_CAP_MS away, so a skip or seek the user makes
 *   on the phone is seen within that long.
 * - Within PLAYING_CAP_MS of the end, it reads the queue once. If the next song
 *   is blocked, it looks again PRE_SKIP_MS before the end and skips twice:
 *   the last moment of this song, then the blocked one, so the blocked song is
 *   never heard for more than the time a skip takes to land. The cost is the
 *   last ~0.7 s of the song before it. Skipping from inside the blocked song
 *   instead would play a second or so of it.
 * - Paused, or nothing playing: once a minute, and every IDLE_LONG_MS after
 *   half an hour of that. Control's own spotify commands make it look at once.
 *
 * Rate limits (developer.spotify.com/documentation/web-api/concepts/rate-limits,
 * read November 2026): counted over a rolling 30-second window, lower for
 * apps in development mode, and no numbers published; going over answers 429
 * with Retry-After in seconds. At steady state the watcher makes 3 player
 * reads a minute while playing (one per 20 s), plus one queue read per song:
 * about 4 a minute, and 1 a minute or less when idle. A 429 waits out
 * Retry-After, at least 30 s, doubling while 429s continue.
 *
 * A listen counts once the same play of a song has progressed, while the
 * listener is plausibly there, past half its length. Only progress seen to
 * advance at the pace of the clock counts; a jump forward (a seek) does not,
 * and paused time never does. "Plausibly there" means some sign of the user
 * within PRESENCE_WINDOW_MS (a Control command, a skip, seek, pause or resume
 * the watcher did not make, or this Mac being used), and, when the music
 * plays on this Mac, the Mac's keyboard and mouse used within MAC_IDLE_MS.
 * Whether taking out AirPods pauses Spotify, so that a forgotten phone does
 * not count, is still to be verified live.
 */

export const PLAYING_CAP_MS = 20_000
const END_SLACK_MS = 100
export const PRE_SKIP_MS = 700
const IDLE_MS = 60_000
const IDLE_LONG_MS = 5 * 60_000
const IDLE_LONG_AFTER_MS = 30 * 60_000
const SIGNED_OUT_MS = 5 * 60_000
const ERROR_MS = 30_000
const RATE_LIMIT_MIN_MS = 30_000
const RATE_LIMIT_MAX_MS = 10 * 60_000
const PRESENCE_WINDOW_MS = 2 * 60 * 60_000
const MAC_IDLE_MS = 30 * 60_000
/** Progress may run this far ahead of the clock between looks before it is called a seek. */
const PROGRESS_SLACK_MS = 2_000
/** After a skip, how long and how often to look for the new song. */
const SKIP_POLLS = 12
const SKIP_POLL_MS = 150
/** Most blocked songs skipped in a row before giving up for this look. */
const MAX_SKIPS = 5

export interface WatcherPlayer {
  playerState(): Promise<PlaybackState | undefined>
  upNext(): Promise<Item | undefined>
  skipNow(): Promise<void>
}

export interface WatcherTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface WatcherDeps {
  player: WatcherPlayer
  taste: TasteStore
  timers: WatcherTimers
  now(): number
  sleep(ms: number): Promise<void>
  /** How long this Mac's keyboard and mouse have been idle; undefined when it cannot tell. */
  macIdleMs(): Promise<number | undefined>
  /** This Mac's computer name, which its Spotify app is listed under. */
  thisMacName(): Promise<string | undefined>
  log(message: string): void
}

function runText(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5_000 }, (err, stdout) => resolve(err ? undefined : stdout))
  })
}

/** HIDIdleTime, in nanoseconds, from `ioreg`, as milliseconds. */
export function parseHidIdle(ioreg: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)
  return match ? Math.round(Number(match[1]) / 1e6) : undefined
}

export const REAL_MAC_IDLE = async (): Promise<number | undefined> => {
  const out = await runText('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'])
  return out ? parseHidIdle(out) : undefined
}

export const REAL_TIMERS: WatcherTimers = {
  set: (fn, ms) => setTimeout(fn, ms).unref(),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One play of one song, as the listening log follows it. */
interface Play {
  uri: string
  track: TrackInfo
  durationMs: number
  progressMs: number
  at: number
  playing: boolean
  listenedMs: number
  counted: boolean
  device: string
  context?: string
}

function trackOf(item: Item): TrackInfo {
  return {
    uri: item.uri ?? '',
    name: item.name,
    artists: item.artists?.map((a) => a.name) ?? [],
    ...(item.album?.name ? { album: item.album.name } : {}),
    ...(item.duration_ms ? { durationMs: item.duration_ms } : {}),
  }
}

function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[‘’`]/g, "'")
  return norm(a) === norm(b)
}

export class SkipWatcher {
  private timer: unknown
  private running = false
  private checking = false
  private recheck = false
  private play: Play | undefined
  private lastSign: number
  private idleSince: number | undefined
  private rateLimitMs = 0
  /** Set when the next song is blocked: the song playing now, to skip just before it ends. */
  private preSkip: string | undefined
  /** The song whose queue was already read this play, so it is read once. */
  private peeked: string | undefined
  /** The watcher's own skips, so they are not taken for the user's. */
  private ownSkip = false

  constructor(private readonly deps: WatcherDeps) {
    this.lastSign = deps.now()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  stop(): void {
    this.running = false
    if (this.timer !== undefined) this.deps.timers.clear(this.timer)
    this.timer = undefined
  }

  /** The user did something: a sign they are there, and a reason to look again now. */
  nudge(): void {
    this.lastSign = this.deps.now()
    if (!this.running) return
    if (this.checking) this.recheck = true
    else this.schedule(0)
  }

  private schedule(ms: number): void {
    if (!this.running) return
    if (this.timer !== undefined) this.deps.timers.clear(this.timer)
    this.timer = this.deps.timers.set(() => {
      this.timer = undefined
      void this.check()
    }, Math.max(0, Math.round(ms)))
  }

  /** One look at the player. Never rejects. Exposed for tests. */
  async check(): Promise<void> {
    if (this.checking) {
      this.recheck = true
      return
    }
    this.checking = true
    let next: number
    try {
      next = await this.look()
      this.rateLimitMs = 0
    } catch (err) {
      next = this.failed(err)
    } finally {
      this.checking = false
    }
    if (this.recheck) {
      this.recheck = false
      next = 0
    }
    this.schedule(next)
  }

  private failed(err: unknown): number {
    if (err instanceof SignInNeeded) return SIGNED_OUT_MS
    if (err instanceof SpotifyApiError && err.status === 429) {
      this.rateLimitMs = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, (err.retryAfterS ?? 0) * 1000, this.rateLimitMs * 2))
      this.deps.log(`[spotify-watcher] rate limited; next look in ${Math.round(this.rateLimitMs / 1000)} s`)
      return this.rateLimitMs
    }
    this.deps.log(`[spotify-watcher] look failed: ${err instanceof Error ? err.message : String(err)}`)
    return ERROR_MS
  }

  /** Look, act, and say when to look next. */
  private async look(): Promise<number> {
    let state = await this.deps.player.playerState()
    const now = this.deps.now()
    await this.observe(state, now)

    if (state?.is_playing && state.item?.uri) {
      const pre = this.preSkip
      this.preSkip = undefined
      const left = (state.item.duration_ms ?? 0) - (state.progress_ms ?? 0)
      // Only just before the end: a seek back since the queue was read means the blocked song is not due yet.
      const endingIntoBlocked = pre === state.item.uri && left <= PRE_SKIP_MS + PROGRESS_SLACK_MS
      if (pre === state.item.uri && !endingIntoBlocked) this.peeked = undefined
      if (this.deps.taste.isBlocked(state.item.uri) || endingIntoBlocked) {
        state = await this.skipBlocked(state)
        await this.observe(state, this.deps.now())
        if (!state?.is_playing) return this.idleDelay(this.deps.now())
      }
    }

    if (!state?.is_playing || !state.item) return this.idleDelay(now)
    this.idleSince = undefined
    const duration = state.item.duration_ms ?? 0
    const remaining = Math.max(0, duration - (state.progress_ms ?? 0))
    if (!duration) return PLAYING_CAP_MS
    if (remaining <= PLAYING_CAP_MS && this.peeked !== state.item.uri) {
      this.peeked = state.item.uri
      const upcoming = await this.deps.player.upNext()
      if (this.deps.taste.isBlocked(upcoming?.uri) && state.item.uri) {
        this.preSkip = state.item.uri
        return Math.max(0, remaining - PRE_SKIP_MS)
      }
    }
    return Math.min(remaining + END_SLACK_MS, PLAYING_CAP_MS)
  }

  private idleDelay(now: number): number {
    this.idleSince ??= now
    return now - this.idleSince >= IDLE_LONG_AFTER_MS ? IDLE_LONG_MS : IDLE_MS
  }

  /**
   * Skip the song playing now, and whatever blocked songs come after it, up
   * to MAX_SKIPS; the player as it was left.
   */
  private async skipBlocked(state: PlaybackState): Promise<PlaybackState | undefined> {
    let current: PlaybackState | undefined = state
    for (let skips = 0; skips < MAX_SKIPS && current?.item?.uri; skips++) {
      const from: string | undefined = current.item?.uri
      this.deps.log(`[spotify-watcher] skipping "${current.item?.name}"${this.deps.taste.isBlocked(from) ? ' (blocked)' : ' (a blocked song is next)'}`)
      this.ownSkip = true
      await this.deps.player.skipNow()
      for (let poll = 0; poll < SKIP_POLLS; poll++) {
        await this.deps.sleep(SKIP_POLL_MS)
        current = await this.deps.player.playerState()
        if (current?.item?.uri !== from) break
      }
      if (!this.deps.taste.isBlocked(current?.item?.uri)) return current
    }
    return current
  }

  /** Follow the play for the listening log, and notice the user's own skips, seeks, pauses and resumes. */
  private async observe(state: PlaybackState | undefined, now: number): Promise<void> {
    const own = this.ownSkip
    this.ownSkip = false
    const item = state?.item
    const prev = this.play
    if (!state || !item?.uri || !item.uri.startsWith('spotify:track:')) {
      if (prev) {
        prev.at = now
        prev.playing = false
      }
      return
    }
    const progress = state.progress_ms ?? 0
    const playing = state.is_playing
    if (!prev || prev.uri !== item.uri) {
      if (prev && !own && prev.playing && prev.durationMs - prev.progressMs > now - prev.at + PROGRESS_SLACK_MS + END_SLACK_MS) {
        this.sign(now) // skipped away from a song before it ended
      }
      if (prev && !own && !prev.playing && playing) this.sign(now)
      this.play = {
        uri: item.uri, track: trackOf(item), durationMs: item.duration_ms ?? 0, progressMs: progress, at: now,
        playing, listenedMs: 0, counted: false, device: state.device.name, ...(state.context?.uri ? { context: state.context.uri } : {}),
      }
      return
    }
    const elapsed = now - prev.at
    const advanced = progress - prev.progressMs
    if (prev.playing !== playing) this.sign(now)
    if (advanced > elapsed + PROGRESS_SLACK_MS) {
      this.sign(now) // a seek forward: not listened to
    } else if (advanced < -PROGRESS_SLACK_MS) {
      // Back to the start is a new play (repeat, or restart); elsewhere, a seek back.
      if (progress < 5_000) {
        prev.listenedMs = 0
        prev.counted = false
      }
      if (!own) this.sign(now)
    } else if (prev.playing && advanced > 0 && await this.present(state, now)) {
      prev.listenedMs += advanced
    }
    prev.progressMs = progress
    prev.at = now
    prev.playing = playing
    prev.device = state.device.name
    if (!prev.counted && prev.durationMs > 0 && prev.listenedMs >= prev.durationMs / 2) {
      prev.counted = true
      this.deps.taste.addListen(prev.track, prev.listenedMs, { device: prev.device, ...(prev.context ? { context: prev.context } : {}) })
      this.deps.log(`[spotify-watcher] heard "${prev.track.name}"`)
    }
  }

  private sign(now: number): void {
    this.lastSign = Math.max(this.lastSign, now)
  }

  /** Whether the listener is plausibly there; this Mac in use counts as a sign. */
  private async present(state: PlaybackState, now: number): Promise<boolean> {
    const idle = await this.deps.macIdleMs()
    if (idle !== undefined && idle < MAC_IDLE_MS) this.sign(now - idle)
    if (now - this.lastSign > PRESENCE_WINDOW_MS) return false
    const macName = await this.deps.thisMacName()
    const onThisMac = !!macName && sameName(state.device.name, macName)
    return !onThisMac || idle === undefined || idle < MAC_IDLE_MS
  }
}
