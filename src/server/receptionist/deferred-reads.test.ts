import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { DeferredReads } from './deferred-reads'

const KEVIN = { nodeId: asNodeId('kevin'), stateSince: 1 }
const SALLY = { nodeId: asNodeId('sally') }

describe('DeferredReads', () => {
  it('settles only replies before the message, by whether each was taken in whole', () => {
    const reads = new DeferredReads()
    reads.defer(10, [KEVIN])
    reads.defer(20, [SALLY])
    reads.defer(40, [SALLY])
    expect(reads.settle(30, at => at === 10)).toEqual({ done: [KEVIN], dropped: [SALLY] })
    // Settled once: a later message finds them gone, and the reply after the first still waits.
    expect(reads.settle(50, () => true)).toEqual({ done: [SALLY], dropped: [] })
  })

  it('drops a cut reply for good', () => {
    const reads = new DeferredReads()
    reads.defer(10, [KEVIN])
    expect(reads.cut(10)).toEqual([KEVIN])
    expect(reads.settle(30, () => true)).toEqual({ done: [], dropped: [] })
  })
})
