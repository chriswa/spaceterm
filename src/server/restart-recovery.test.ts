import { describe, it, expect } from 'vitest'
import { RestartRecoveryLedger, RECOVERY_WINDOW_MS } from './restart-recovery'
import { asNodeId, asPtySessionId } from '../shared/ids'

const NODE = asNodeId('node-1')
const OTHER_NODE = asNodeId('node-2')
const PTY = asPtySessionId('pty-new')
const OLD_PTY = asPtySessionId('pty-old')
const T0 = 1_700_000_000_000

function ledgerWatching(startedAt = T0, isRetry = false) {
  const ledger = new RestartRecoveryLedger()
  ledger.record(NODE, { sessionId: PTY, previousExtraCliArgs: '--old-flag', startedAt, isRetry })
  return ledger
}

describe('a restarted pty that dies quickly', () => {
  it('is recovered with the previous arguments', () => {
    const decision = ledgerWatching().onExit(NODE, PTY, T0 + 500)
    expect(decision).toEqual({ kind: 'recover', previousExtraCliArgs: '--old-flag', elapsedMs: 500 })
  })

  it('is recovered right up to the window, but not at it', () => {
    expect(ledgerWatching().onExit(NODE, PTY, T0 + RECOVERY_WINDOW_MS - 1).kind).toBe('recover')
    expect(ledgerWatching().onExit(NODE, PTY, T0 + RECOVERY_WINDOW_MS).kind).toBe('give-up')
  })

  it('is recovered even on an instant exit', () => {
    expect(ledgerWatching().onExit(NODE, PTY, T0).kind).toBe('recover')
  })
})

describe('a restarted pty that ran for a while', () => {
  it('is not recovered — it did not fail to launch', () => {
    const decision = ledgerWatching().onExit(NODE, PTY, T0 + 60_000)
    expect(decision).toMatchObject({ kind: 'give-up', reason: 'window-elapsed' })
  })

  it('reports how long it ran, so the log says why', () => {
    const decision = ledgerWatching().onExit(NODE, PTY, T0 + 60_000)
    expect(decision).toMatchObject({ elapsedMs: 60_000 })
  })
})

describe('only the pty this restart spawned is evidence', () => {
  it('ignores an unrelated pty exiting on the same node', () => {
    // A surface can exit for a dozen reasons. Recovering on an unrelated exit
    // would silently revert arguments the user deliberately set.
    expect(ledgerWatching().onExit(NODE, OLD_PTY, T0 + 100)).toEqual({ kind: 'ignore' })
  })

  it('keeps watching after an unrelated exit', () => {
    // Dropping the entry here would disarm recovery for the pty that is
    // actually being watched.
    const ledger = ledgerWatching()
    ledger.onExit(NODE, OLD_PTY, T0 + 100)
    expect(ledger.size).toBe(1)
    expect(ledger.onExit(NODE, PTY, T0 + 200).kind).toBe('recover')
  })

  it('ignores an exit on a node with no restart being watched', () => {
    expect(ledgerWatching().onExit(OTHER_NODE, PTY, T0 + 100)).toEqual({ kind: 'ignore' })
  })

  it('ignores an exit on an empty ledger', () => {
    expect(new RestartRecoveryLedger().onExit(NODE, PTY, T0)).toEqual({ kind: 'ignore' })
  })
})

describe('recovering at most once', () => {
  it('does not recover a retry, however fast it died', () => {
    // If the reverted arguments also fail, the arguments were not the problem,
    // and looping would spawn ptys forever.
    const decision = ledgerWatching(T0, true).onExit(NODE, PTY, T0 + 10)
    expect(decision).toMatchObject({ kind: 'give-up', reason: 'already-retried' })
  })

  it('reports already-retried ahead of window-elapsed when both apply', () => {
    // The reason goes in the log; "we already tried" is the useful one.
    const decision = ledgerWatching(T0, true).onExit(NODE, PTY, T0 + 60_000)
    expect(decision).toMatchObject({ reason: 'already-retried' })
  })

  it('marks the relaunch as a retry', () => {
    const ledger = ledgerWatching()
    expect(ledger.onExit(NODE, PTY, T0 + 100).kind).toBe('recover')

    const retryPty = asPtySessionId('pty-retry')
    ledger.recordRetry(NODE, retryPty, '--old-flag', T0 + 200)
    expect(ledger.onExit(NODE, retryPty, T0 + 250)).toMatchObject({ reason: 'already-retried' })
  })

  it('runs the full sequence: restart fails, recover, retry fails, give up', () => {
    const ledger = new RestartRecoveryLedger()
    ledger.record(NODE, { sessionId: PTY, previousExtraCliArgs: '--good', startedAt: T0, isRetry: false })

    const first = ledger.onExit(NODE, PTY, T0 + 300)
    expect(first).toMatchObject({ kind: 'recover', previousExtraCliArgs: '--good' })

    const retryPty = asPtySessionId('pty-retry')
    ledger.recordRetry(NODE, retryPty, '--good', T0 + 400)
    expect(ledger.onExit(NODE, retryPty, T0 + 500).kind).toBe('give-up')
    expect(ledger.size).toBe(0)
  })
})

describe('bookkeeping', () => {
  it('consumes the attempt on a decision, so one exit cannot act twice', () => {
    const ledger = ledgerWatching()
    expect(ledger.onExit(NODE, PTY, T0 + 100).kind).toBe('recover')
    expect(ledger.onExit(NODE, PTY, T0 + 100)).toEqual({ kind: 'ignore' })
    expect(ledger.size).toBe(0)
  })

  it('consumes the attempt on give-up too', () => {
    const ledger = ledgerWatching()
    ledger.onExit(NODE, PTY, T0 + 60_000)
    expect(ledger.size).toBe(0)
  })

  it('forgets an attempt on request, for a relaunch that never spawned', () => {
    const ledger = ledgerWatching()
    ledger.forget(NODE)
    expect(ledger.onExit(NODE, PTY, T0 + 100)).toEqual({ kind: 'ignore' })
  })

  it('is safe to forget a node it is not watching', () => {
    expect(() => new RestartRecoveryLedger().forget(NODE)).not.toThrow()
  })

  it('replaces a previous attempt rather than stacking them', () => {
    // Restarting twice in quick succession should watch the newer pty.
    const ledger = ledgerWatching()
    const newer = asPtySessionId('pty-newer')
    ledger.record(NODE, { sessionId: newer, previousExtraCliArgs: '--x', startedAt: T0 + 50, isRetry: false })

    expect(ledger.size).toBe(1)
    expect(ledger.onExit(NODE, PTY, T0 + 100)).toEqual({ kind: 'ignore' })
    expect(ledger.onExit(NODE, newer, T0 + 100).kind).toBe('recover')
  })

  it('watches several nodes independently', () => {
    const ledger = ledgerWatching()
    const otherPty = asPtySessionId('pty-other')
    ledger.record(OTHER_NODE, { sessionId: otherPty, previousExtraCliArgs: '--b', startedAt: T0, isRetry: false })

    expect(ledger.onExit(NODE, PTY, T0 + 100)).toMatchObject({ previousExtraCliArgs: '--old-flag' })
    expect(ledger.onExit(OTHER_NODE, otherPty, T0 + 100)).toMatchObject({ previousExtraCliArgs: '--b' })
  })

  it('carries an empty previous-args string through, which means "no extra args"', () => {
    // Reverting to "no arguments at all" is the common case, and an empty
    // string must not be confused with "nothing recorded".
    const ledger = new RestartRecoveryLedger()
    ledger.record(NODE, { sessionId: PTY, previousExtraCliArgs: '', startedAt: T0, isRetry: false })
    expect(ledger.onExit(NODE, PTY, T0 + 100)).toEqual({ kind: 'recover', previousExtraCliArgs: '', elapsedMs: 100 })
  })
})
