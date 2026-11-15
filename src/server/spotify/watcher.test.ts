import { describe, expect, it } from 'vitest'
import { SpotifyApiError, memoryTasteFiles, type Item, type PlaybackState } from './index'
import { TasteStore, type TasteFiles } from './taste'
import { parseHidIdle, PLAYING_CAP_MS, PRE_SKIP_MS, SkipWatcher } from './watcher'

const MIN = 60_000
const SONGS: Item[] = [
  { uri: 'spotify:track:a', name: 'Alpha', artists: [{ name: 'Lyst' }], duration_ms: 3 * MIN },
  { uri: 'spotify:track:b', name: 'Bravo', artists: [{ name: 'Lyst' }], duration_ms: 3 * MIN },
  { uri: 'spotify:track:c', name: 'Charlie', artists: [{ name: 'Ana' }], duration_ms: 3 * MIN },
  { uri: 'spotify:track:d', name: 'Delta', artists: [{ name: 'Ana' }], duration_ms: 3 * MIN },
]

/**
 * A Spotify player that plays SONGS in order on a fake clock, timers that
 * fire as the clock is moved on, and a record of what the watcher asked.
 */
function harness(opts: { device?: string; macIdleMs?: number; files?: TasteFiles } = {}) {
  let clock = 1_000_000
  let index = 0
  let startedAt = clock
  let base = 0
  let playing = true
  const calls: string[] = []
  const timers: { fn: () => void; at: number; id: number }[] = []
  let nextId = 0
  let failNext: Error | undefined
  const files = opts.files ?? memoryTasteFiles()
  const taste = new TasteStore(files, () => clock)

  const progress = () => (playing ? base + (clock - startedAt) : base)
  /** Move the player along to the clock: songs end into the next. */
  const advancePlayer = () => {
    for (;;) {
      const duration = SONGS[index].duration_ms ?? 0
      if (!playing || progress() < duration) return
      const endedAt = startedAt + (duration - base)
      index = (index + 1) % SONGS.length
      startedAt = endedAt
      base = 0
    }
  }
  const skip = () => {
    advancePlayer()
    index = (index + 1) % SONGS.length
    startedAt = clock
    base = 0
  }

  const watcher = new SkipWatcher({
    player: {
      playerState: async (): Promise<PlaybackState | undefined> => {
        calls.push('state')
        if (failNext) {
          const err = failNext
          failNext = undefined
          throw err
        }
        advancePlayer()
        return { device: { id: 'd', name: opts.device ?? 'iPhone', type: 'Smartphone', is_active: true, volume_percent: null }, is_playing: playing, progress_ms: progress(), item: SONGS[index] }
      },
      upNext: async () => {
        calls.push('queue')
        advancePlayer()
        return SONGS[(index + 1) % SONGS.length]
      },
      skipNow: async () => {
        calls.push(`skip ${SONGS[index].name}@${Math.round((progress()) / 100) / 10}s`)
        skip()
      },
    },
    taste,
    timers: {
      set: (fn, ms) => {
        const id = nextId++
        timers.push({ fn, at: clock + ms, id })
        return id
      },
      clear: (id) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      },
    },
    now: () => clock,
    // Skips land at once here, so a poll after one sees the new song.
    sleep: async (ms) => { clock += ms },
    macIdleMs: async () => opts.macIdleMs,
    thisMacName: async () => 'MacBook Pro',
    log: () => {},
  })

  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  /** Run every timer due up to `ms` from now, in order, letting each look finish. */
  const advance = async (ms: number) => {
    const until = clock + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const due = timers[0]
      if (!due || due.at > until) break
      timers.shift()
      clock = Math.max(clock, due.at)
      due.fn()
      await flush()
    }
    clock = until
  }

  return {
    watcher, taste, calls, files, advance, flush,
    get clock() { return clock },
    nextTimerIn: () => Math.min(...timers.map((t) => t.at)) - clock,
    current: () => SONGS[index].name,
    pause: () => { base = progress(); playing = false },
    resume: () => { startedAt = clock; playing = true },
    seek: (ms: number) => { base = ms; startedAt = clock },
    failWith: (err: Error) => { failNext = err },
  }
}

describe('SkipWatcher', () => {
  it('looks when the song is due to end, at most every 20 seconds, rather than every second', async () => {
    const h = harness()
    h.watcher.start()
    await h.advance(0)
    expect(h.nextTimerIn()).toBe(PLAYING_CAP_MS)
    await h.advance(3 * MIN)
    // 180 s of a song at one look per 20 s, plus one queue read near its end.
    expect(h.calls.filter((c) => c === 'state').length).toBeLessThanOrEqual(11)
    expect(h.calls.filter((c) => c === 'queue')).toHaveLength(1)
  })

  it('backs off while paused, and looks at once when nudged', async () => {
    const h = harness()
    h.pause()
    h.watcher.start()
    await h.advance(0)
    expect(h.nextTimerIn()).toBe(60_000)
    await h.advance(30 * MIN)
    expect(h.nextTimerIn()).toBe(5 * MIN)
    h.resume()
    h.watcher.nudge()
    await h.advance(0)
    expect(h.nextTimerIn()).toBe(PLAYING_CAP_MS)
  })

  it('skips a blocked song that is playing', async () => {
    const h = harness()
    h.taste.setVerdict('dislike', { uri: 'spotify:track:a', name: 'Alpha', artists: ['Lyst'] })
    h.watcher.start()
    await h.advance(0)
    expect(h.calls).toContain('skip Alpha@0s')
    expect(h.current()).toBe('Bravo')
  })

  it('skips out of the song before a blocked one just before it ends, then past the blocked one', async () => {
    const h = harness()
    h.taste.setVerdict('dislike', { uri: 'spotify:track:b', name: 'Bravo', artists: ['Lyst'] })
    h.watcher.start()
    await h.advance(3 * MIN + 1_000)
    const skips = h.calls.filter((c) => c.startsWith('skip'))
    expect(skips).toHaveLength(2)
    expect(skips[0]).toBe(`skip Alpha@${(3 * MIN - PRE_SKIP_MS) / 1000}s`)
    // The blocked song is left as soon as the first skip is seen to land.
    expect(skips[1]).toMatch(/^skip Bravo@0\.[0-4]s$/)
    expect(h.current()).toBe('Charlie')
  })

  it('does not pre-skip when the user seeked back after the queue was read', async () => {
    const h = harness()
    h.taste.setVerdict('dislike', { uri: 'spotify:track:b', name: 'Bravo', artists: ['Lyst'] })
    h.watcher.start()
    await h.advance(3 * MIN - 15_000)
    expect(h.calls).toContain('queue')
    h.seek(60_000)
    await h.advance(14_400)
    expect(h.calls.filter((c) => c.startsWith('skip'))).toEqual([])
    expect(h.current()).toBe('Alpha')
  })

  it('waits out a 429 for at least its Retry-After, doubling while they continue', async () => {
    const h = harness()
    h.failWith(new SpotifyApiError(429, 'rate limited', 45))
    h.watcher.start()
    await h.advance(0)
    expect(h.nextTimerIn()).toBe(45_000)
    h.failWith(new SpotifyApiError(429, 'rate limited', 10))
    await h.advance(45_000)
    expect(h.nextTimerIn()).toBe(90_000)
    await h.advance(90_000)
    expect(h.nextTimerIn()).toBeLessThanOrEqual(PLAYING_CAP_MS)
  })

  it('counts a listen once the song played past half, once per play', async () => {
    const h = harness()
    h.watcher.start()
    await h.advance(80_000)
    expect(h.taste.get('spotify:track:a')?.listens ?? 0).toBe(0)
    await h.advance(20_000)
    expect(h.taste.get('spotify:track:a')?.listens).toBe(1)
    await h.advance(70_000)
    expect(h.taste.get('spotify:track:a')?.listens).toBe(1)
    const line = JSON.parse(h.files.readLines('spotify-listens.jsonl')[0]) as { track: { name: string }; device: string }
    expect(line.track.name).toBe('Alpha')
    expect(line.device).toBe('iPhone')
  })

  it('does not count paused time, or a seek past halfway', async () => {
    const h = harness()
    h.watcher.start()
    await h.advance(40_000)
    h.pause()
    await h.advance(10 * MIN)
    h.resume()
    h.seek(120_000)
    h.watcher.nudge()
    await h.advance(30_000)
    expect(h.taste.get('spotify:track:a')?.listens ?? 0).toBe(0)
  })

  it('does not count music left playing with nobody about: no sign of the user in two hours', async () => {
    const h = harness()
    h.watcher.start()
    // Songs play on unattended; the watcher's own looks are no sign of anyone.
    await h.advance(2 * 60 * MIN + 3 * MIN)
    const before = h.taste.all().reduce((n, r) => n + r.listens, 0)
    await h.advance(12 * MIN)
    expect(h.taste.all().reduce((n, r) => n + r.listens, 0)).toBe(before)
    h.watcher.nudge()
    await h.advance(3 * MIN)
    expect(h.taste.all().reduce((n, r) => n + r.listens, 0)).toBeGreaterThan(before)
  })

  it('does not count music playing on this Mac while its keyboard and mouse sit idle', async () => {
    const idle = harness({ device: 'MacBook Pro', macIdleMs: 45 * MIN })
    idle.watcher.start()
    await idle.advance(3 * MIN)
    expect(idle.taste.get('spotify:track:a')?.listens ?? 0).toBe(0)

    const busy = harness({ device: 'MacBook Pro', macIdleMs: 10_000 })
    busy.watcher.start()
    await busy.advance(3 * MIN)
    expect(busy.taste.get('spotify:track:a')?.listens).toBe(1)
  })

  it('reads the HID idle time ioreg prints, in milliseconds', () => {
    expect(parseHidIdle('  |   "HIDIdleTime" = 1234567890\n')).toBe(1235)
    expect(parseHidIdle('nothing')).toBeUndefined()
  })
})
