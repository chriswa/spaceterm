import { describe, it, expect } from 'vitest'
import type { ApprovalItem, ApprovalsSnapshot } from '../shared/approvals'
import { approvalKey } from '../shared/approvals'
import { takeArrivals, unreadCount } from './approvals-store'
import { lostStatusKeys } from './provider-status'

function snapshot(...ids: string[]): ApprovalsSnapshot {
  const items = ids.map((id) => ({ source: 'opProxy', id }) as ApprovalItem)
  return { sources: [], items, closed: [] }
}

describe('takeArrivals', () => {
  it('announces each request once, however often it is re-sent', () => {
    const announced = new Set<string>()
    expect(takeArrivals(snapshot('a'), announced)).toHaveLength(1)
    expect(takeArrivals(snapshot('a'), announced)).toEqual([])
    expect(takeArrivals(snapshot(), announced)).toEqual([])
    expect(takeArrivals(snapshot('a', 'b'), announced)).toEqual([approvalKey({ source: 'opProxy', id: 'b' })])
  })

  it('stays quiet for requests already read', () => {
    const announced = new Set([approvalKey({ source: 'opProxy', id: 'a' })])
    expect(takeArrivals(snapshot('a'), announced)).toEqual([])
  })
})

describe('unreadCount', () => {
  const lost = (since: number): ApprovalsSnapshot => ({
    sources: [{ name: 'opProxy', connected: true, pairedKeys: [], status: { ok: false, label: '1Password', since } }],
    items: [],
    closed: []
  })

  it('counts a lost authorization until it has been seen, and again when it is lost anew', () => {
    expect(unreadCount(lost(1), [], new Set())).toBe(1)
    const seen = new Set(lostStatusKeys(lost(1)))
    expect(unreadCount(lost(1), [], seen)).toBe(0)
    expect(unreadCount(lost(2), [], seen)).toBe(1)
  })
})
