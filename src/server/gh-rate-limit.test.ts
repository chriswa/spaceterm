import { describe, it, expect } from 'vitest'
import {
  GhRateLimitPoller,
  parseGhRateLimitResponse,
  isGhRateLimitData,
  GH_RATE_LIMIT_POLL_MS,
  GH_RATE_LIMIT_SLOT_MINUTES,
  type CancelScheduled,
  type GhRateLimitDeps,
  type GhRateLimitReport
} from './gh-rate-limit'
import type { GhRateLimitData } from '../shared/protocol'

const NOW = 1_700_000_000_000

function reading(used: number, limit = 5000): GhRateLimitData {
  return { limit, used, resetAt: '2024-01-01T00:00:00Z' }
}

class FakeDeps implements GhRateLimitDeps {
  /** Queued fetch outcomes, consumed in order; the last one repeats. */
  responses: Array<GhRateLimitData | Error> = [reading(100)]
  cached: GhRateLimitData | undefined
  readonly written: GhRateLimitData[] = []
  readonly logged: Record<string, unknown>[] = []
  readonly logPath = '/fake/gh_rate_limit.jsonl'
  fetches = 0

  private tick: (() => void) | null = null
  intervalMs: number | null = null

  async fetch(): Promise<GhRateLimitData> {
    this.fetches++
    const next = this.responses.length > 1 ? this.responses.shift()! : this.responses[0]
    if (next instanceof Error) throw next
    return next
  }

  readCache(): GhRateLimitData | undefined { return this.cached }
  writeCache(data: GhRateLimitData): void { this.written.push(data) }
  appendLog(entry: Record<string, unknown>): void { this.logged.push(entry) }

  scheduleInterval(fn: () => void, ms: number): CancelScheduled {
    this.tick = fn
    this.intervalMs = ms
    return () => { this.tick = null }
  }

  get armed(): boolean { return this.tick !== null }
  fire(): void { this.tick?.() }
}

function harness(configure: (d: FakeDeps) => void = () => {}) {
  const deps = new FakeDeps()
  configure(deps)
  const reports: GhRateLimitReport[] = []
  const poller = new GhRateLimitPoller((r) => reports.push(r), deps)
  return { poller, deps, reports }
}

describe('parseGhRateLimitResponse', () => {
  it('converts remaining into used', () => {
    // The API reports what is left; the sparkline plots what has been consumed.
    const out = parseGhRateLimitResponse(
      JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4200, resetAt: 'T' } } })
    )
    expect(out).toEqual({ limit: 5000, used: 800, resetAt: 'T' })
  })

  it('rejects a response missing the rateLimit block', () => {
    expect(() => parseGhRateLimitResponse(JSON.stringify({ data: {} }))).toThrow(/Unexpected/)
  })

  it('rejects a field of the wrong type', () => {
    expect(() =>
      parseGhRateLimitResponse(JSON.stringify({ data: { rateLimit: { limit: '5000', remaining: 1, resetAt: 'T' } } }))
    ).toThrow(/Unexpected/)
  })

  it('rejects an error envelope, which gh returns with exit code 0', () => {
    expect(() => parseGhRateLimitResponse(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })))
      .toThrow(/Unexpected/)
  })

  it('propagates a JSON parse failure', () => {
    expect(() => parseGhRateLimitResponse('not json')).toThrow()
  })
})

describe('isGhRateLimitData', () => {
  it('accepts a complete reading', () => {
    expect(isGhRateLimitData(reading(1))).toBe(true)
  })

  it('rejects a partial or malformed one', () => {
    expect(isGhRateLimitData({ limit: 1, used: 2 })).toBe(false)
    expect(isGhRateLimitData({ limit: '1', used: 2, resetAt: 'T' })).toBe(false)
    expect(isGhRateLimitData(null)).toBe(false)
    expect(isGhRateLimitData('nope')).toBe(false)
  })
})

describe('start', () => {
  it('polls immediately rather than waiting a full interval', async () => {
    const h = harness()
    await h.poller.start()

    expect(h.deps.fetches).toBe(1)
    expect(h.reports).toHaveLength(1)
  })

  it('schedules the recurring poll at the documented cadence', async () => {
    const h = harness()
    await h.poller.start()
    expect(h.deps.intervalMs).toBe(GH_RATE_LIMIT_POLL_MS)
  })

  it('serves the cached reading before the first fetch returns', () => {
    const h = harness((d) => { d.cached = reading(42) })
    void h.poller.start()

    // A client connecting in this window should not see an empty sparkline.
    expect(h.poller.current()?.data).toEqual(reading(42))
  })

  it('has nothing to serve when there is no cache and no successful poll', async () => {
    const h = harness((d) => { d.responses = [new Error('gh: command not found')] })
    await h.poller.start()

    expect(h.poller.current()).toBeUndefined()
  })
})

describe('poll', () => {
  it('reports the reading with history and slot width', async () => {
    const h = harness((d) => { d.responses = [reading(300)] })
    await h.poller.poll(NOW)

    expect(h.reports[0].data).toEqual(reading(300))
    expect(h.reports[0].slotMinutes).toBe(GH_RATE_LIMIT_SLOT_MINUTES)
    expect(Array.isArray(h.reports[0].usedHistory)).toBe(true)
  })

  it('caches every successful reading, so the next run starts warm', async () => {
    const h = harness((d) => { d.responses = [reading(1), reading(2)] })
    await h.poller.poll(NOW)
    await h.poller.poll(NOW + GH_RATE_LIMIT_POLL_MS)

    expect(h.deps.written.map((w) => w.used)).toEqual([1, 2])
  })

  it('appends each reading to the history log with a timestamp', async () => {
    const h = harness((d) => { d.responses = [reading(7)] })
    await h.poller.poll(NOW)

    expect(h.deps.logged[0]).toMatchObject({
      used: 7,
      limit: 5000,
      timestamp: new Date(NOW).toISOString()
    })
  })

  it('records history across polls', async () => {
    const h = harness((d) => { d.responses = [reading(10), reading(20), reading(30)] })
    await h.poller.poll(NOW)
    await h.poller.poll(NOW + GH_RATE_LIMIT_POLL_MS)
    await h.poller.poll(NOW + GH_RATE_LIMIT_POLL_MS * 2)

    const history = h.reports[2].usedHistory.filter((v) => v !== null)
    expect(history).toContain(30)
    expect(history.length).toBeGreaterThan(1)
  })

  describe('when gh fails', () => {
    // `gh` missing or unauthenticated is the common case for a new user, and
    // must not take anything else down.
    it('does not throw', async () => {
      const h = harness((d) => { d.responses = [new Error('gh: command not found')] })
      await expect(h.poller.poll(NOW)).resolves.toBeUndefined()
    })

    it('reports nothing rather than a blank reading', async () => {
      const h = harness((d) => { d.responses = [new Error('boom')] })
      await h.poller.poll(NOW)

      expect(h.reports).toEqual([])
      expect(h.deps.written).toEqual([])
      expect(h.deps.logged).toEqual([])
    })

    it('keeps the last good reading available', async () => {
      const h = harness((d) => { d.responses = [reading(50), new Error('network down')] })
      await h.poller.poll(NOW)
      await h.poller.poll(NOW + GH_RATE_LIMIT_POLL_MS)

      expect(h.poller.current()?.data).toEqual(reading(50))
    })

    it('keeps polling — a transient failure is not terminal', async () => {
      const h = harness((d) => { d.responses = [new Error('flaky'), reading(5)] })
      await h.poller.start()
      expect(h.reports).toEqual([])

      h.deps.fire()
      await Promise.resolve()
      await Promise.resolve()
      expect(h.deps.fetches).toBe(2)
    })
  })
})

describe('dispose', () => {
  it('stops the recurring poll', async () => {
    const h = harness()
    await h.poller.start()

    h.poller.dispose()
    expect(h.deps.armed).toBe(false)

    h.deps.fire()
    expect(h.deps.fetches).toBe(1)
  })

  it('is safe to call twice, or before start', () => {
    const h = harness()
    expect(() => { h.poller.dispose(); h.poller.dispose() }).not.toThrow()
  })
})
