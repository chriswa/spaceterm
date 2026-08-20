import { describe, it, expect, beforeEach } from 'vitest'
import { PendingTurnCache } from './pending-turn'
import { asPtySessionId } from '../shared/ids'
import payloads from './testing/interactive-tool-payloads.json'

const SURFACE = asPtySessionId('surface-1')
const OTHER = asPtySessionId('surface-2')

describe('PendingTurnCache', () => {
  let cache: PendingTurnCache
  beforeEach(() => { cache = new PendingTurnCache() })

  it('holds nothing until an interactive tool is seen', () => {
    expect(cache.get(SURFACE)).toBeUndefined()
  })

  it('records a pending question with its rendered text', () => {
    cache.record(SURFACE, 'AskUserQuestion', payloads.askUserQuestion, 1_000)
    const pending = cache.get(SURFACE)
    expect(pending?.tool).toBe('AskUserQuestion')
    expect(pending?.capturedAt).toBe(1_000)
    expect(pending?.text).toContain('Retries are enabled in production')
  })

  it('records a pending plan', () => {
    cache.record(SURFACE, 'ExitPlanMode', payloads.exitPlanMode, 1_000)
    expect(cache.get(SURFACE)?.tool).toBe('ExitPlanMode')
    expect(cache.get(SURFACE)?.text).toContain('Dashboard: offline mode and blocklists')
  })

  /**
   * Only tools that block on the listener buffer their turn. Caching a Bash
   * call would put shell invocations into a spoken summary, and — worse —
   * would make the cache's presence stop meaning "this surface is waiting".
   */
  it('ignores tools that do not hold a turn open', () => {
    cache.record(SURFACE, 'Bash', { command: 'ls' }, 1_000)
    cache.record(SURFACE, 'Read', { file_path: '/tmp/x' }, 1_000)
    expect(cache.get(SURFACE)).toBeUndefined()
  })

  // A later Bash call cannot follow a question on the same turn, but a stale
  // entry from an *earlier* turn can still be sitting here. Non-interactive
  // tools must leave it alone; only the turn-ending events below clear it.
  it('leaves an existing pending turn alone when another tool runs', () => {
    cache.record(SURFACE, 'AskUserQuestion', payloads.askUserQuestion, 1_000)
    cache.record(SURFACE, 'Bash', { command: 'ls' }, 2_000)
    expect(cache.get(SURFACE)?.tool).toBe('AskUserQuestion')
  })

  it('ignores an interactive tool whose payload renders to nothing', () => {
    cache.record(SURFACE, 'AskUserQuestion', { questions: [] }, 1_000)
    expect(cache.get(SURFACE)).toBeUndefined()
  })

  it('does not throw on a payload shape it does not recognise', () => {
    expect(() => cache.record(SURFACE, 'AskUserQuestion', 'not-an-object', 1_000)).not.toThrow()
    expect(cache.get(SURFACE)).toBeUndefined()
  })

  it('clears when the turn resolves', () => {
    cache.record(SURFACE, 'AskUserQuestion', payloads.askUserQuestion, 1_000)
    cache.clear(SURFACE)
    expect(cache.get(SURFACE)).toBeUndefined()
  })

  it('replaces an earlier pending turn rather than accumulating', () => {
    cache.record(SURFACE, 'AskUserQuestion', payloads.askUserQuestion, 1_000)
    cache.record(SURFACE, 'ExitPlanMode', payloads.exitPlanMode, 2_000)
    expect(cache.get(SURFACE)?.tool).toBe('ExitPlanMode')
    expect(cache.get(SURFACE)?.capturedAt).toBe(2_000)
  })

  // One entry per surface, and surfaces do not see each other's: several agents
  // sit at questions at once, which is the situation the chord is for.
  it('keeps surfaces independent', () => {
    cache.record(SURFACE, 'AskUserQuestion', payloads.askUserQuestion, 1_000)
    cache.record(OTHER, 'ExitPlanMode', payloads.exitPlanMode, 1_000)
    cache.clear(SURFACE)
    expect(cache.get(SURFACE)).toBeUndefined()
    expect(cache.get(OTHER)?.tool).toBe('ExitPlanMode')
  })
})
