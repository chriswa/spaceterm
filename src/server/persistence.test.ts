import { describe, it, expect } from 'vitest'
import { StatePersister, serializeState } from './persistence'
import { CURRENT_STATE_VERSION } from './state-migrations'
import { FakePersistenceIO as FakeIO } from './testing/fake-persistence'
import type { ServerState } from '../shared/state'

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    version: CURRENT_STATE_VERSION,
    nextZIndex: 1,
    nodes: {},
    rootArchivedChildren: [],
    undoBuffer: [],
    undoCursor: 0,
    savedViewports: {},
    ...overrides
  }
}

const DEBOUNCE = 1000

describe('StatePersister.schedule', () => {
  it('does not write until the debounce interval elapses', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    p.schedule(makeState())
    io.advance(DEBOUNCE - 1)
    expect(io.writes).toHaveLength(0)

    io.advance(1)
    expect(io.writes).toHaveLength(1)
  })

  it('coalesces a burst of calls into a single write', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)
    const state = makeState()

    for (let i = 0; i < 10; i++) {
      p.schedule(state)
      io.advance(100)
    }
    expect(io.writes).toHaveLength(0)

    io.advance(DEBOUNCE)
    expect(io.writes).toHaveLength(1)
  })

  it('leaves no armed timer behind after firing', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    p.schedule(makeState())
    expect(p.hasPendingWrite).toBe(true)

    io.advance(DEBOUNCE)
    expect(p.hasPendingWrite).toBe(false)
    expect(io.liveTimers).toBe(0)
  })

  it('writes the state as it is at flush time, not at schedule time', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)
    const state = makeState()

    p.schedule(state)
    state.nextZIndex = 42
    io.advance(DEBOUNCE)

    expect(JSON.parse(io.writes[0]).nextZIndex).toBe(42)
  })
})

describe('StatePersister.flush', () => {
  it('writes immediately', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    p.flush(makeState())
    expect(io.writes).toHaveLength(1)
  })

  it('cancels a pending debounced write rather than letting it fire later', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)
    const state = makeState()

    p.schedule(state)
    p.flush(state)
    expect(io.writes).toHaveLength(1)

    io.advance(DEBOUNCE * 2)
    expect(io.writes).toHaveLength(1)
    expect(io.liveTimers).toBe(0)
  })

  it('propagates write failures to the caller', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    io.failNextWrite = true
    expect(() => p.flush(makeState())).toThrow(/write failed/)
  })
})

describe('StatePersister.cancel', () => {
  it('drops a pending write without performing it', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    p.schedule(makeState())
    p.cancel()
    io.advance(DEBOUNCE * 2)

    expect(io.writes).toHaveLength(0)
    expect(p.hasPendingWrite).toBe(false)
  })

  it('is a no-op when nothing is pending', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)
    expect(() => p.cancel()).not.toThrow()
  })
})

describe('StatePersister instances are independent', () => {
  // This is the regression the refactor exists to prevent: the debounce timer
  // used to be module-scoped, so a second persister's schedule() silently
  // cancelled the first one's pending write and its state was never saved.
  it('does not let one persister cancel another persister pending write', () => {
    const ioA = new FakeIO()
    const ioB = new FakeIO()
    const a = new StatePersister(ioA, DEBOUNCE)
    const b = new StatePersister(ioB, DEBOUNCE)

    a.schedule(makeState({ nextZIndex: 1 }))
    b.schedule(makeState({ nextZIndex: 2 }))

    ioA.advance(DEBOUNCE)
    ioB.advance(DEBOUNCE)

    expect(ioA.writes).toHaveLength(1)
    expect(ioB.writes).toHaveLength(1)
    expect(JSON.parse(ioA.writes[0]).nextZIndex).toBe(1)
    expect(JSON.parse(ioB.writes[0]).nextZIndex).toBe(2)
  })
})

describe('StatePersister.load', () => {
  it('reports an empty store as a first run', () => {
    const { state, outcome } = new StatePersister(new FakeIO()).load()
    expect(outcome.status).toBe('empty')
    expect(state.nodes).toEqual({})
    expect(state.version).toBe(CURRENT_STATE_VERSION)
  })

  it('round-trips a written document', () => {
    const io = new FakeIO()
    const p = new StatePersister(io, DEBOUNCE)

    p.flush(makeState({ nextZIndex: 7 }))
    const { state, outcome } = new StatePersister(io).load()

    expect(outcome.status).toBe('ok')
    expect(state.nextZIndex).toBe(7)
  })

  it('does not archive on a clean load — no migration ran', () => {
    const io = new FakeIO()
    new StatePersister(io, DEBOUNCE).flush(makeState())
    io.archived.length = 0

    new StatePersister(io).load()
    expect(io.archived).toHaveLength(0)
  })

  describe('when the document cannot be honoured', () => {
    // Starting empty is right — refusing to boot is worse — but the old file
    // must survive, because the very next mutation overwrites it.
    it('preserves a malformed document instead of overwriting it', () => {
      const io = new FakeIO()
      io.stored = '{ not json'

      const { state, outcome } = new StatePersister(io).load()

      expect(outcome.status).toBe('corrupt')
      expect(state.nodes).toEqual({})
      expect(io.archived).toEqual([{ label: 'unreadable', content: '{ not json' }])
    })

    it('preserves a document missing required fields', () => {
      const io = new FakeIO()
      io.seed({ version: 1 }) // no nodes

      const { outcome } = new StatePersister(io).load()

      expect(outcome).toMatchObject({ status: 'corrupt' })
      expect(io.archived[0].label).toBe('unreadable')
    })

    it('refuses a document from a newer build and preserves it under its version', () => {
      const io = new FakeIO()
      io.seed({ version: CURRENT_STATE_VERSION + 5, nodes: { a: { id: 'a' } } })

      const { state, outcome } = new StatePersister(io).load()

      expect(outcome).toMatchObject({
        status: 'too-new',
        found: CURRENT_STATE_VERSION + 5,
        supported: CURRENT_STATE_VERSION
      })
      expect(state.nodes).toEqual({})
      expect(io.archived[0].label).toBe(`v${CURRENT_STATE_VERSION + 5}`)
    })
  })

  it('archives the pre-migration document when a migration runs', () => {
    const io = new FakeIO()
    io.seed({ version: 1, nextZIndex: 3, nodes: {} })

    const { state, outcome } = new StatePersister(io).load()

    expect(outcome).toMatchObject({ status: 'ok', migratedFrom: 1 })
    expect(state.version).toBe(CURRENT_STATE_VERSION)
    expect(io.archived).toEqual([{ label: 'v1', content: JSON.stringify({ version: 1, nextZIndex: 3, nodes: {} }) }])
  })
})

describe('serializeState', () => {
  it('strips ephemeral gitStatus at any depth', () => {
    const state = makeState({
      nodes: {
        a: {
          id: 'a',
          type: 'directory',
          gitStatus: { branch: 'main' }
        } as never
      }
    })

    const parsed = JSON.parse(serializeState(state))
    expect(parsed.nodes.a.gitStatus).toBeUndefined()
    expect(parsed.nodes.a.id).toBe('a')
  })
})
