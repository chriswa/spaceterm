import { describe, expect, it } from 'vitest'
import { composeMicOn, rememberComposeMic } from './compose-mic-memory'
import type { MemoryStorage } from './browser-storage'

function memory(): MemoryStorage {
  const items = new Map<string, string>()
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v) }, removeItem: (k) => { items.delete(k) } }
}

describe('remembering the composer’s microphone', () => {
  it('opens into dictation until a prompt is shipped with the microphone off', () => {
    const store = memory()
    expect(composeMicOn(store)).toBe(true)
    rememberComposeMic(false, store)
    expect(composeMicOn(store)).toBe(false)
    rememberComposeMic(true, store)
    expect(composeMicOn(store)).toBe(true)
  })

  it('opens into dictation without storage, or with storage that throws', () => {
    rememberComposeMic(false, null)
    expect(composeMicOn(null)).toBe(true)
    const broken: MemoryStorage = { getItem: () => { throw new Error('no') }, setItem: () => { throw new Error('no') }, removeItem: () => {} }
    rememberComposeMic(false, broken)
    expect(composeMicOn(broken)).toBe(true)
  })
})
