import { describe, expect, it } from 'vitest'
import { rememberHandsFree, rememberedHandsFree } from './hands-free-memory'
import type { MemoryStorage } from './browser-storage'

function memory(): MemoryStorage {
  const items = new Map<string, string>()
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v) }, removeItem: (k) => { items.delete(k) } }
}

describe('remembering hands-free', () => {
  it('keeps it on across a restart of the same build, and forgets it when turned off', () => {
    const store = memory()
    expect(rememberedHandsFree('app-1', store)).toBe(false)
    rememberHandsFree(true, 'app-1', store)
    expect(rememberedHandsFree('app-1', store)).toBe(true)
    rememberHandsFree(false, 'app-1', store)
    expect(rememberedHandsFree('app-1', store)).toBe(false)
  })

  it('starts a replaced app with hands-free off', () => {
    const store = memory()
    rememberHandsFree(true, 'app-1', store)
    expect(rememberedHandsFree('app-2', store)).toBe(false)
  })

  it('remembers nothing without storage, or with storage that throws', () => {
    rememberHandsFree(true, 'x', null)
    expect(rememberedHandsFree('x', null)).toBe(false)
    const broken: MemoryStorage = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => {} }
    rememberHandsFree(true, 'x', broken)
    expect(rememberedHandsFree('x', broken)).toBe(false)
  })
})
