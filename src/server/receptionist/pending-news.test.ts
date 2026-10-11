import { describe, it, expect } from 'vitest'
import { PendingNews } from './pending-news'
import type { NameRegistryStore } from './name-registry'
import type { ReceptionistEvent } from './prompt'

function memoryStore(json?: string): NameRegistryStore {
  const store = { json, load: () => store.json, save: (next: string) => { store.json = next } }
  return store
}

const ended = (agent: string): ReceptionistEvent => ({ kind: 'agent-ended', agent, archived: true, lastSaid: '', cache: {} })

describe('PendingNews', () => {
  it('keeps waiting news for the next server', () => {
    const store = memoryStore()
    new PendingNews({ store }).push(ended('{Kevin:amber-otter}'))
    expect(new PendingNews({ store }).all()).toEqual([ended('{Kevin:amber-otter}')])
  })

  it('tells again news a turn took and never finished with, ahead of what came after', () => {
    const store = memoryStore()
    const news = new PendingNews({ store })
    news.push(ended('a'))
    news.take({})
    news.push(ended('b'))
    expect(new PendingNews({ store }).all().map(e => e.agent)).toEqual(['a', 'b'])
  })

  it('forgets news once the turn that took it is over', () => {
    const store = memoryStore()
    const news = new PendingNews({ store })
    news.push(ended('a'))
    const turn = {}
    news.take(turn)
    news.told(turn)
    expect(new PendingNews({ store }).all()).toEqual([])
  })

  it('lets a superseded turn not drop what its successor took', () => {
    const store = memoryStore()
    const news = new PendingNews({ store })
    const first = {}
    const second = {}
    news.push(ended('a'))
    news.requeue(news.take(first), first)
    news.take(second)
    news.told(first)
    expect(new PendingNews({ store }).all().map(e => e.agent)).toEqual(['a'])
  })

  it('drops what matches', () => {
    const store = memoryStore()
    const news = new PendingNews({ store })
    news.push(ended('a'))
    news.push(ended('b'))
    news.drop(event => event.agent === 'a')
    expect(new PendingNews({ store }).all().map(e => e.agent)).toEqual(['b'])
  })

  it('starts with no news from a corrupt file, and skips what is not news', () => {
    expect(new PendingNews({ store: memoryStore('{nope') }).all()).toEqual([])
    expect(new PendingNews({ store: memoryStore(JSON.stringify({ waiting: [{ kind: 'mystery', agent: 'x' }, ended('a')] })) }).all())
      .toEqual([ended('a')])
  })
})
