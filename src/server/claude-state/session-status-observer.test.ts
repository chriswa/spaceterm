import { describe, it, expect } from 'vitest'
import {
  SessionStatusObserver,
  agreementOf,
  expectedStates,
  type ObservedSurface,
  type SessionStatusObservation,
  type SessionStatusObserverDeps
} from './session-status-observer'
import type { PtySessionId, ClaudeSessionId } from '../../shared/ids'
import type { CcSessionStatus } from '../../shared/state'
import type { ClaudeState } from './types'

const surfaceId = 'surface-1' as PtySessionId
const claudeSessionId = 'sess-a' as ClaudeSessionId

/** One `onStatus` call: what the footer would be told to show. */
type Reported = [PtySessionId, CcSessionStatus | null, string | null]

interface Harness {
  observer: SessionStatusObserver
  lines: SessionStatusObservation[]
  reported: Reported[]
  setRegistry(files: Record<string, unknown>): void
  setSurfaces(surfaces: ObservedSurface[]): void
  tick(): void
}

function harness(now = 5_000): Harness {
  let files: Record<string, unknown> = {}
  let surfaces: ObservedSurface[] = []
  const lines: SessionStatusObservation[] = []
  const reported: Reported[] = []
  const deps: SessionStatusObserverDeps = {
    registry: {
      listPidFiles: () => Object.keys(files),
      readPidFile: (name) => (name in files ? JSON.stringify(files[name]) : null),
      pidAlive: () => true
    },
    append: (_id, line) => lines.push(JSON.parse(line) as SessionStatusObservation),
    // The observer is driven by tick(), not by a timer.
    scheduleInterval: () => () => {},
    now: () => now
  }
  const observer = new SessionStatusObserver(
    () => surfaces,
    (surfaceId, status, waitingFor) => reported.push([surfaceId, status, waitingFor]),
    deps
  )
  return {
    observer,
    lines,
    reported,
    setRegistry: (next) => { files = next },
    setSurfaces: (next) => { surfaces = next },
    tick: () => observer.observe()
  }
}

function surface(state: ClaudeState, over: Partial<ObservedSurface> = {}): ObservedSurface {
  return { surfaceId, claudeSessionId, agentType: 'claude', state, ...over }
}

describe('expectedStates', () => {
  it('maps busy to both working colours', () => {
    // Claude Code has no equivalent of the yellow main-turn-over distinction,
    // so working_background must not read as a disagreement.
    expect(expectedStates('busy')).toEqual(['working', 'working_background'])
  })

  it('maps idle to stopped and its annotated form', () => {
    expect(expectedStates('idle')).toEqual(['stopped', 'potential_error'])
  })

  it('has no opinion on shell or an absent status', () => {
    expect(expectedStates('shell')).toBeNull()
    expect(expectedStates(undefined)).toBeNull()
  })
})

describe('agreementOf', () => {
  it('scores the stuck-orange bug as a disagreement', () => {
    // The observation this whole module exists for: an interrupt (with or
    // without a rewind) leaves Claude Code idle while we still say working.
    expect(agreementOf('idle', 'working')).toBe('disagree')
  })

  it('scores a matched pair as agreement', () => {
    expect(agreementOf('waiting', 'waiting_plan')).toBe('agree')
    expect(agreementOf('busy', 'working_background')).toBe('agree')
  })

  it('never calls an unmodelled status a disagreement', () => {
    expect(agreementOf('shell', 'working')).toBe('no-opinion')
    expect(agreementOf(undefined, 'stopped')).toBe('no-opinion')
  })
})

describe('SessionStatusObserver', () => {
  it('records the pairing, the verdict and the lag', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle', statusUpdatedAt: 1_000, kind: 'interactive' } })
    h.setSurfaces([surface('working', { stateDecidedAt: 1_600 })])
    h.tick()

    expect(h.lines).toHaveLength(1)
    const [entry] = h.lines
    expect(entry.agreement).toBe('disagree')
    expect(entry.cc.status).toBe('idle')
    expect(entry.spaceterm.state).toBe('working')
    expect(entry.pid).toBe(100)
    // Positive lag = the registry knew first, which is the claim being measured.
    expect(entry.lagMs).toBe(600)
  })

  it('writes nothing while nothing changes', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()
    h.tick()
    h.tick()
    expect(h.lines).toHaveLength(1)
  })

  it('writes again when either side moves', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()

    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle', statusUpdatedAt: 2_000 } })
    h.tick()
    h.setSurfaces([surface('stopped')])
    h.tick()

    expect(h.lines.map((l) => `${l.cc.status}/${l.spaceterm.state}`)).toEqual([
      'busy/working',
      'idle/working',
      'idle/stopped'
    ])
  })

  it('logs a fresh status change even when our state is unmoved', () => {
    // statusUpdatedAt advancing with the same status value is a real transition
    // (busy → idle → busy inside one tick window), so it must not be deduped.
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 4_000 } })
    h.tick()
    expect(h.lines).toHaveLength(2)
  })

  it('ignores non-claude surfaces, which have no registry to compare against', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working', { agentType: 'codex' })])
    h.tick()
    expect(h.lines).toEqual([])
  })

  it('ignores a surface with no claude session yet', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working', { claudeSessionId: null })])
    h.tick()
    expect(h.lines).toEqual([])
  })

  it('says nothing about a session with no registry record', () => {
    const h = harness()
    h.setRegistry({})
    h.setSurfaces([surface('working')])
    h.tick()
    expect(h.lines).toEqual([])
  })

  it('stays quiet when a record vanishes for a tick and comes back unchanged', () => {
    // A torn read or a read racing the file's rewrite looks exactly like this.
    // Nothing about the session changed, so nothing is worth logging.
    const h = harness()
    const record = { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 }
    h.setRegistry({ '100.json': record })
    h.setSurfaces([surface('working')])
    h.tick()
    h.setRegistry({})
    h.tick()
    h.setRegistry({ '100.json': record })
    h.tick()
    expect(h.lines).toHaveLength(1)
  })

  it('logs a baseline for a new claude session on the same surface', () => {
    // Reincarnation: same surface, different session. It gets its own baseline
    // even when it opens on the status the previous session ended on.
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()

    h.setRegistry({ '101.json': { pid: 101, sessionId: 'sess-b', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working', { claudeSessionId: 'sess-b' as ClaudeSessionId })])
    h.tick()

    expect(h.lines.map((l) => l.claudeSessionId)).toEqual(['sess-a', 'sess-b'])
  })

  it('reports the status for the footer, once per change', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()
    h.tick()
    expect(h.reported).toEqual([[surfaceId, 'busy', null]])

    h.setRegistry({
      '100.json': { pid: 100, sessionId: 'sess-a', status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: 2_000 }
    })
    h.tick()
    expect(h.reported[1]).toEqual([surfaceId, 'waiting', 'dialog open'])
  })

  it('does not redraw the footer when only our own state moves', () => {
    // Our state already has its own broadcast; re-reporting an unchanged
    // registry status on top of it would be pure churn.
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()
    h.setSurfaces([surface('stopped')])
    h.tick()
    expect(h.lines).toHaveLength(2)
    expect(h.reported).toHaveLength(1)
  })

  it('clears the footer with an explicit null when the record disappears', () => {
    // A dead session's last status must not keep showing — and the clear has to
    // be null, not undefined: the value crosses the socket as JSON, where
    // JSON.stringify drops undefined fields and the clear would arrive as {}.
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'busy', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working')])
    h.tick()
    h.setRegistry({})
    h.tick()
    expect(h.reported).toEqual([
      [surfaceId, 'busy', null],
      [surfaceId, null, null]
    ])
    expect(JSON.stringify({ fields: { ccStatus: h.reported[1][1] } })).toContain('ccStatus')
  })

  it('reports nothing for a non-claude surface', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle', statusUpdatedAt: 1_000 } })
    h.setSurfaces([surface('working', { agentType: 'cursor' })])
    h.tick()
    expect(h.reported).toEqual([])
  })

  it('omits lagMs when either timestamp is missing', () => {
    const h = harness()
    h.setRegistry({ '100.json': { pid: 100, sessionId: 'sess-a', status: 'idle' } })
    h.setSurfaces([surface('working')])
    h.tick()
    expect(h.lines[0].lagMs).toBeUndefined()
    expect(h.lines[0].cc.statusUpdatedAt).toBeUndefined()
  })
})
