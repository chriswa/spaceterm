import { describe, it, expect } from 'vitest'
import { promptStore, HISTORY_LIMIT, type PromptStorage } from './prompt-store'
import { asNodeId } from '../shared/ids'

function memoryStorage(): PromptStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: (k) => { data.delete(k) }
  }
}

describe('promptStore', () => {
  it('keeps the draft per surface', () => {
    const storage = memoryStorage()
    promptStore(asNodeId('a'), storage).setDraft('for a')
    expect(promptStore(asNodeId('a'), storage).draft()).toBe('for a')
    expect(promptStore(asNodeId('b'), storage).draft()).toBe('')
  })

  it('shipping clears the draft at once and remembers what was sent', () => {
    const storage = memoryStorage()
    const store = promptStore(asNodeId('a'), storage)
    store.setDraft('fix the flaky test')
    store.shipped('fix the flaky test')
    // A fresh store — the next time the composer opens — sees no draft.
    expect(promptStore(asNodeId('a'), storage).draft()).toBe('')
    expect(promptStore(asNodeId('a'), storage).history()).toEqual(['fix the flaky test'])
  })

  it('remembers newest first, without repeats, up to a limit', () => {
    const store = promptStore(asNodeId('a'), memoryStorage())
    store.shipped('one')
    store.shipped('two')
    store.shipped('one')
    expect(store.history()).toEqual(['one', 'two'])
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) store.shipped(`p${i}`)
    expect(store.history()).toHaveLength(HISTORY_LIMIT)
    expect(store.history()[0]).toBe(`p${HISTORY_LIMIT + 4}`)
  })

  it('clearing keeps the text recoverable, like shipping', () => {
    const store = promptStore(asNodeId('a'), memoryStorage())
    store.setDraft('half a thought')
    store.cleared('half a thought')
    expect(store.draft()).toBe('')
    expect(store.history()).toEqual(['half a thought'])
  })

  it('clearing nothing remembers nothing', () => {
    const store = promptStore(asNodeId('a'), memoryStorage())
    store.cleared('')
    expect(store.history()).toEqual([])
  })

  it('survives storage that throws', () => {
    const broken: PromptStorage = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') }
    }
    const store = promptStore(asNodeId('a'), broken)
    expect(() => store.shipped('x')).not.toThrow()
    expect(store.draft()).toBe('')
    expect(store.history()).toEqual([])
  })
})
