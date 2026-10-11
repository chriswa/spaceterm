import { describe, it, expect } from 'vitest'
import type { NodeId } from '../../shared/ids'
import { EndedAgents, MAX_ENDED } from './ended-agents'
import type { NameRegistryStore } from './name-registry'
import type { RosterAgent } from './roster'

function memoryStore(json?: string): NameRegistryStore & { json?: string } {
  const store = { json, load: () => store.json, save: (next: string) => { store.json = next } }
  return store
}

const agent = (id: string, extra: Partial<RosterAgent> = {}): RosterAgent =>
  ({ nodeId: id as NodeId, title: `agent ${id}`, state: 'stopped', claudeSessionId: `session-${id}`, ...extra })

describe('EndedAgents', () => {
  it('is read back by the next server, newest last', () => {
    const store = memoryStore()
    const first = new EndedAgents({ store })
    first.remember({ agent: agent('a'), handle: 'amber-otter' })
    first.remember({ agent: agent('b', { cacheWarmUntil: 123 }), handle: 'frost-gecko' })

    const next = new EndedAgents({ store })
    expect(next.values().map(ended => ended.handle)).toEqual(['amber-otter', 'frost-gecko'])
    expect(next.get('b' as NodeId)?.agent.cacheWarmUntil).toBe(123)
  })

  it('makes one that ends again the newest, but an update keeps its place', () => {
    const store = memoryStore()
    const ended = new EndedAgents({ store })
    ended.remember({ agent: agent('a'), handle: 'amber-otter' })
    ended.remember({ agent: agent('b'), handle: 'frost-gecko' })
    ended.update('a' as NodeId, agent('a', { cacheWarmUntil: 5 }))
    expect(new EndedAgents({ store }).values().map(e => e.handle)).toEqual(['amber-otter', 'frost-gecko'])
    ended.remember({ agent: agent('a'), handle: 'amber-otter' })
    expect(new EndedAgents({ store }).values().map(e => e.handle)).toEqual(['frost-gecko', 'amber-otter'])
  })

  it('forgets one brought back, on disk too', () => {
    const store = memoryStore()
    const ended = new EndedAgents({ store })
    ended.remember({ agent: agent('a'), handle: 'amber-otter' })
    ended.delete('a' as NodeId)
    expect(new EndedAgents({ store }).values()).toEqual([])
  })

  it('keeps only the newest', () => {
    const ended = new EndedAgents({ store: memoryStore() })
    for (let i = 0; i <= MAX_ENDED; i++) ended.remember({ agent: agent(`n${i}`), handle: `h${i}` })
    expect(ended.values()).toHaveLength(MAX_ENDED)
    expect(ended.get('n0' as NodeId)).toBeUndefined()
  })

  it('starts empty from a corrupt or malformed file', () => {
    expect(new EndedAgents({ store: memoryStore('{not json') }).values()).toEqual([])
    expect(new EndedAgents({ store: memoryStore(JSON.stringify({ ended: [{ handle: 'x' }, { agent: agent('a'), handle: 'amber-otter' }] })) })
      .values().map(e => e.handle)).toEqual(['amber-otter'])
  })
})
