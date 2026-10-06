import { describe, it, expect } from 'vitest'
import type { ApprovalItem, ApprovalsSnapshot } from '../shared/approvals'
import { approvalKey } from '../shared/approvals'
import { takeArrivals } from './approvals-store'

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
