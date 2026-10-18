import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { DeferredReads } from './deferred-reads'
import type { NameRegistryStore } from './name-registry'

const KEVIN = { nodeId: asNodeId('kevin'), stateSince: 1 }
const SALLY = { nodeId: asNodeId('sally') }

function memoryStore(json?: string): NameRegistryStore {
  return { load: () => json, save: (next) => { json = next } }
}

describe('DeferredReads', () => {
  it('settles only replies before the message, by whether each was taken in whole', () => {
    const reads = new DeferredReads({ store: memoryStore() })
    reads.defer(10, [KEVIN])
    reads.defer(20, [SALLY])
    reads.defer(40, [SALLY])
    expect(reads.settle(30, at => at === 10)).toEqual({ done: [KEVIN], dropped: [SALLY] })
    // Settled once: a later message finds them gone, and the reply after the first still waits.
    expect(reads.settle(50, () => true)).toEqual({ done: [SALLY], dropped: [] })
  })

  it('drops a cut reply for good', () => {
    const reads = new DeferredReads({ store: memoryStore() })
    reads.defer(10, [KEVIN])
    expect(reads.cut(10, () => false)).toEqual([KEVIN])
    expect(reads.settle(30, () => true)).toEqual({ done: [], dropped: [] })
  })

  it('keeps waiting the agents of a cut reply the user had taken in all of', () => {
    const wyatt = { nodeId: asNodeId('wyatt'), parts: [0] }
    const reads = new DeferredReads({ store: memoryStore() })
    reads.defer(10, [wyatt, SALLY])
    expect(reads.cut(10, read => read === wyatt)).toEqual([SALLY])
    // Still waiting on the user's answer, as a reply heard through does.
    expect(reads.settle(30, (_, read) => read.nodeId === wyatt.nodeId)).toEqual({ done: [wyatt], dropped: [] })
  })

  it('keeps which parts are an agent\'s own across a restart', () => {
    const store = memoryStore()
    const wyatt = { nodeId: asNodeId('wyatt'), stateSince: 3, parts: [0, 2] }
    const before = new DeferredReads({ store })
    before.defer(10, [wyatt])
    before.heardOut()
    expect(new DeferredReads({ store }).settle(30, () => true)).toEqual({ done: [wyatt], dropped: [] })
  })

  it('outlives the server, once how much of the reply was heard is known', () => {
    const store = memoryStore()
    const before = new DeferredReads({ store })
    before.defer(10, [KEVIN])
    before.heardOut()
    before.defer(20, [SALLY])
    before.cut(20, () => false)
    const after = new DeferredReads({ store })
    expect(after.settle(30, () => true)).toEqual({ done: [KEVIN], dropped: [] })
  })

  it('drops the reply the last server went in the middle of, and keeps the ones before it', () => {
    const store = memoryStore()
    const before = new DeferredReads({ store })
    before.defer(10, [KEVIN])
    before.heardOut()
    before.defer(20, [SALLY])
    const after = new DeferredReads({ store })
    expect(after.settle(30, () => true)).toEqual({ done: [KEVIN], dropped: [] })
    // And the file says so, for the server after that.
    expect(new DeferredReads({ store }).settle(30, () => true)).toEqual({ done: [], dropped: [] })
  })

  it('starts with nothing waiting from a corrupt file', () => {
    const reads = new DeferredReads({ store: memoryStore('{not json') })
    expect(reads.settle(30, () => true)).toEqual({ done: [], dropped: [] })
  })
})
