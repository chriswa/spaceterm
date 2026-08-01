import { describe, it, expect } from 'vitest'
import { planSurfaceRecovery, orphanedDaemonSessions } from './startup-reconciliation'
import { asClaudeSessionId, asPtySessionId, type PtySessionId } from '../shared/ids'

const PTY = asPtySessionId('pty-1')
const SESSION = asClaudeSessionId('claude-1')

const live = (id: PtySessionId = PTY, cols = 120, rows = 40) => ({ id, alive: true, cols, rows })
const dead = (id: PtySessionId = PTY) => ({ id, alive: false, cols: 80, rows: 24 })

describe('planSurfaceRecovery', () => {
  describe('when the daemon still holds the pty', () => {
    it('reattaches, carrying the daemon geometry', () => {
      // The pty has scrollback and a running process; respawning throws both
      // away even though the agent is still sitting there.
      expect(planSurfaceRecovery({ daemonSession: live(), requiresResumableSession: true }))
        .toEqual({ action: 'reattach', sessionId: PTY, cols: 120, rows: 40 })
    })

    it('reattaches even when there is a resumable session to fall back to', () => {
      expect(planSurfaceRecovery({
        daemonSession: live(),
        resumeSessionId: SESSION,
        requiresResumableSession: true
      })).toMatchObject({ action: 'reattach' })
    })

    it('reattaches even for an agent that could not be revived at all', () => {
      // No resume target and requiresResumableSession would normally archive.
      // A live pty outranks that: the conversation is still running.
      expect(planSurfaceRecovery({ daemonSession: live(), requiresResumableSession: true }))
        .toMatchObject({ action: 'reattach' })
    })
  })

  describe('when the daemon entry is dead', () => {
    it('does not reattach — that would attach the surface to a corpse', () => {
      // The daemon reports exited sessions so the server can clean them up.
      expect(planSurfaceRecovery({ daemonSession: dead(), resumeSessionId: SESSION, requiresResumableSession: true }))
        .toEqual({ action: 'revive', resumeSessionId: SESSION })
    })

    it('archives when there is also nothing to resume', () => {
      expect(planSurfaceRecovery({ daemonSession: dead(), requiresResumableSession: true }))
        .toEqual({ action: 'archive', reason: 'no-resumable-session' })
    })
  })

  describe('when the daemon has nothing', () => {
    it('revives with the resume target', () => {
      expect(planSurfaceRecovery({ resumeSessionId: SESSION, requiresResumableSession: true }))
        .toEqual({ action: 'revive', resumeSessionId: SESSION })
    })

    it('revives fresh for an agent that does not need a session', () => {
      // A shell or Cursor surface can come back empty and still be useful.
      expect(planSurfaceRecovery({ requiresResumableSession: false }))
        .toEqual({ action: 'revive' })
    })

    it('omits the key rather than sending an undefined resume target', () => {
      const plan = planSurfaceRecovery({ requiresResumableSession: false })
      expect('resumeSessionId' in plan).toBe(false)
    })

    it('archives an agent that requires a session and has none', () => {
      // Launching it would open an empty conversation the user did not ask
      // for, and it would be archived on its first exit anyway — so archive up
      // front, where it is at least explicable.
      expect(planSurfaceRecovery({ requiresResumableSession: true }))
        .toEqual({ action: 'archive', reason: 'no-resumable-session' })
    })

    it('revives with a session even for an agent that does not require one', () => {
      expect(planSurfaceRecovery({ resumeSessionId: SESSION, requiresResumableSession: false }))
        .toEqual({ action: 'revive', resumeSessionId: SESSION })
    })
  })

  it('treats an empty-string resume target as no target', () => {
    // The ingest path uses '' for "nothing recorded", and it reaches here.
    expect(planSurfaceRecovery({ resumeSessionId: asClaudeSessionId(''), requiresResumableSession: true }))
      .toEqual({ action: 'archive', reason: 'no-resumable-session' })
  })

  it('covers every combination without falling through to undefined', () => {
    for (const daemonSession of [undefined, live(), dead()]) {
      for (const resumeSessionId of [undefined, SESSION]) {
        for (const requiresResumableSession of [true, false]) {
          const plan = planSurfaceRecovery({ daemonSession, resumeSessionId, requiresResumableSession })
          expect(['reattach', 'revive', 'archive'], JSON.stringify({ daemonSession, resumeSessionId, requiresResumableSession }))
            .toContain(plan.action)
        }
      }
    }
  })
})

describe('orphanedDaemonSessions', () => {
  const a = asPtySessionId('a')
  const b = asPtySessionId('b')
  const c = asPtySessionId('c')

  it('returns live sessions no surface claimed', () => {
    // A pty the server lost track of holds a process and a megabyte of ring
    // buffer forever, invisible to the user.
    const sessions = [live(a), live(b), live(c)]
    expect(orphanedDaemonSessions(sessions, new Set([a])).map((s) => s.id)).toEqual([b, c])
  })

  it('leaves claimed sessions alone', () => {
    expect(orphanedDaemonSessions([live(a)], new Set([a]))).toEqual([])
  })

  it('ignores already-exited sessions', () => {
    // Destroying one is a no-op the daemon still has to answer; doing it for
    // every historical entry on every boot is noise.
    expect(orphanedDaemonSessions([dead(a)], new Set())).toEqual([])
  })

  it('returns nothing when the daemon is empty', () => {
    expect(orphanedDaemonSessions([], new Set([a]))).toEqual([])
  })

  it('returns everything when nothing was claimed', () => {
    expect(orphanedDaemonSessions([live(a), live(b)], new Set()).map((s) => s.id)).toEqual([a, b])
  })

  it('preserves the full session objects, not just ids', () => {
    const sessions = [{ ...live(a), pid: 4242 }]
    expect(orphanedDaemonSessions(sessions, new Set())[0].pid).toBe(4242)
  })
})
