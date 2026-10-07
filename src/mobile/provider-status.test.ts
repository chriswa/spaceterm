import { describe, it, expect } from 'vitest'
import type { ApprovalSource, ApprovalsSnapshot } from '../shared/approvals'
import { longTimeLeft, lostStatusKeys, providerState, shortTimeLeft } from './provider-status'

const OK = { ok: true, label: '1Password', since: 0, until: 12 * 3600_000 }
const LOST = { ok: false, label: '1Password', since: 500, title: '1Password authorization lost' }

function source(over: Partial<ApprovalSource>): ApprovalSource {
  return { name: 'opProxy', connected: true, pairedKeys: [], ...over }
}

describe('providerState', () => {
  it('is unreachable while the feed is down, whatever it last said', () => {
    expect(providerState(source({ connected: false, status: OK }))).toEqual({ kind: 'unreachable' })
  })

  it('shows nothing for a provider that sends no status', () => {
    expect(providerState(source({}))).toBeNull()
  })

  it('follows the status', () => {
    expect(providerState(source({ status: OK }))?.kind).toBe('ok')
    expect(providerState(source({ status: LOST }))?.kind).toBe('lost')
  })
})

describe('lostStatusKeys', () => {
  const snap = (status: typeof LOST | typeof OK): ApprovalsSnapshot => ({ sources: [source({ status })], items: [], closed: [] })

  it('a loss is a notice, and losing it again later is a new one', () => {
    expect(lostStatusKeys(snap(OK))).toEqual([])
    const first = lostStatusKeys(snap(LOST))
    expect(first).toHaveLength(1)
    expect(lostStatusKeys(snap({ ...LOST, since: 900 }))).not.toEqual(first)
  })
})

describe('time left', () => {
  it('rounds the bar label as the Mac menu bar does', () => {
    expect(shortTimeLeft(11.5 * 3600_000, 0)).toBe('12h')
    expect(shortTimeLeft(42 * 60_000, 0)).toBe('42m')
    expect(shortTimeLeft(20_000, 0)).toBe('<1m')
    expect(shortTimeLeft(0, 5_000)).toBe('<1m')
  })

  it('spells out hours and minutes for the panel', () => {
    expect(longTimeLeft((11 * 60 + 32) * 60_000 + 5_000, 0)).toBe('11h 32m')
    expect(longTimeLeft(32 * 60_000, 0)).toBe('32m')
  })
})
