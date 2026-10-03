import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { asNodeId, type NodeId } from '../../shared/ids'
import { fileStore, NameRegistry, type NameRegistryStore } from './name-registry'
import { NAME_VOICE_TABLE, RECEPTIONIST_VOICE } from './name-voice-table'
import { phoneticKey } from './name-phonetics'

const VOICE_COUNT = new Set(NAME_VOICE_TABLE.map((e) => e.voice)).size

function memoryStore(): NameRegistryStore & { json?: string } {
  const store: NameRegistryStore & { json?: string } = {
    load: () => store.json,
    save: (json) => { store.json = json },
  }
  return store
}

/** A registry whose liveness is a mutable set of archived/deleted nodes. */
function setup(store = memoryStore()) {
  const dead = new Set<NodeId>()
  const reg = new NameRegistry({ isLive: (id) => !dead.has(id), store })
  return { reg, dead, store }
}

const node = (i: number | string): NodeId => asNodeId(`node-${i}`)

/**
 * Hold every name, then pick `count` holders whose release leaves no other
 * name newly eligible: their phonetic key is theirs alone (releasing Dana would
 * also free Dean) and their voice stays held by someone else (a freed voice
 * would be preferred). The next assignments can then only take these names
 * back, which isolates the least-recently-used rule.
 */
function fillAndPickReleasable(reg: NameRegistry, count: number): NodeId[] {
  const held: NodeId[] = []
  for (let i = 0; reg.assign(node(i), 1000 + i); i++) held.push(node(i))
  const keyCount = new Map<string | undefined, number>()
  for (const e of NAME_VOICE_TABLE) keyCount.set(phoneticKey(e.name), (keyCount.get(phoneticKey(e.name)) ?? 0) + 1)
  const picked: NodeId[] = []
  const usedVoices = new Set<string>()
  for (const id of held) {
    const e = reg.get(id)!
    if (keyCount.get(phoneticKey(e.name)) !== 1 || usedVoices.has(e.voice)) continue
    picked.push(id)
    usedVoices.add(e.voice)
    if (picked.length === count) break
  }
  expect(picked).toHaveLength(count)
  return picked
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})

describe('NameRegistry', () => {
  it('assigns lazily and sticks', () => {
    const { reg } = setup()
    expect(reg.get(node(1))).toBeUndefined()
    const first = reg.assign(node(1), 1000)
    expect(first).toBeDefined()
    expect(reg.get(node(1))).toEqual(first)
    expect(reg.assign(node(1), 2000)).toEqual(first)
    expect(reg.byName(first!.name)).toBe(node(1))
    expect(reg.byName(first!.name.toUpperCase())).toBe(node(1))
  })

  it('gives distinct voices until every voice is in use, then doubles up', () => {
    const { reg } = setup()
    const voices = Array.from({ length: VOICE_COUNT }, (_, i) => reg.assign(node(i), i)!.voice)
    expect(new Set(voices).size).toBe(VOICE_COUNT)
    const extra = reg.assign(node('extra'), 100)!
    expect(voices).toContain(extra.voice)
  })

  it('never assigns the receptionist voice, a held name, or a sound-alike of one', () => {
    const { reg } = setup()
    const names: string[] = []
    for (let i = 0; i < 200; i++) {
      const a = reg.assign(node(i), i)
      if (!a) break
      expect(a.voice).not.toBe(RECEPTIONIST_VOICE)
      names.push(a.name)
    }
    expect(new Set(names).size).toBe(names.length)
    const keys = names.map((n) => phoneticKey(n))
    expect(new Set(keys).size).toBe(keys.length)
    // Capacity is the number of distinct phonetic keys in the roster.
    expect(names.length).toBe(new Set(NAME_VOICE_TABLE.map((e) => phoneticKey(e.name))).size)
    expect(reg.assign(node('one-too-many'))).toBeUndefined()
  })

  it('releases archived or deleted surfaces only when a new assignment is needed', () => {
    const { reg, dead } = setup()
    const a = reg.assign(node('a'), 1)!
    reg.assign(node('b'), 2)
    dead.add(node('a'))
    expect(reg.get(node('a'))).toEqual(a) // no cleanup yet
    expect(reg.assign(node('b'), 3)).toBeDefined() // existing assignment: still no cleanup
    expect(reg.get(node('a'))).toEqual(a)

    reg.assign(node('c'), 4)
    expect(reg.get(node('a'))).toBeUndefined()
    expect(reg.byName(a.name)).toBeUndefined()
    expect(reg.get(node('b'))).toBeDefined()

    // Unarchived later: it just gets a name again, not necessarily the same one.
    dead.delete(node('a'))
    expect(reg.assign(node('a'), 5)).toBeDefined()
  })

  it('reuses the name used longest ago, never-used names first', () => {
    const { reg, dead } = setup()
    const [x, y, z] = fillAndPickReleasable(reg, 3)
    const names = new Map([x, y, z].map((id) => [id, reg.get(id)!.name]))
    reg.touch(x, 50_000)
    reg.touch(y, 40_000)
    reg.touch(z, 60_000)
    dead.add(x).add(y).add(z)

    expect(reg.assign(node('new-1'), 70_000)!.name).toBe(names.get(y))
    expect(reg.assign(node('new-2'), 70_001)!.name).toBe(names.get(x))
    expect(reg.assign(node('new-3'), 70_002)!.name).toBe(names.get(z))
  })

  it('prefers a never-used name over a released one', () => {
    const { reg, dead } = setup()
    const first = reg.assign(node('a'), 1)!
    dead.add(node('a'))
    expect(reg.assign(node('b'), 2)!.name).not.toBe(first.name)
  })

  it('touch is a no-op for a surface without a name', () => {
    const { reg, store } = setup()
    reg.touch(node('nobody'), 1)
    expect(store.json).toBeUndefined()
  })

  it('round-trips through its store, last-used times included', () => {
    const store = memoryStore()
    const { reg } = setup(store)
    const [a, b] = fillAndPickReleasable(reg, 2)
    reg.touch(a, 30_000)
    reg.touch(b, 20_000)
    const before = new Map(reg.assignedNames().map((n) => [n, reg.byName(n)]))

    const { reg: again, dead } = setup(store)
    expect(new Map(again.assignedNames().map((n) => [n, again.byName(n)]))).toEqual(before)
    expect(again.get(a)).toEqual(reg.get(a))

    // With both released, b (used at 20s) is reused before a (30s).
    dead.add(a).add(b)
    expect(again.assign(node('new-1'), 40_000)!.name).toBe(reg.get(b)!.name)
    expect(again.assign(node('new-2'), 40_001)!.name).toBe(reg.get(a)!.name)
  })

  it('round-trips through the real file store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receptionist-names-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const store = fileStore(join(dir, 'receptionist', 'names.json'))
    expect(store.load()).toBeUndefined()
    const a = setup(store).reg.assign(node('a'), 1)!
    expect(setup(store).reg.get(node('a'))).toEqual(a)
  })

  it('starts empty from a corrupt or foreign document, and drops unknown names', () => {
    const store = memoryStore()
    store.json = '{not json'
    expect(setup(store).reg.assignedNames()).toEqual([])
    store.json = JSON.stringify({ version: 99, assignments: { 'node-a': 'Oliver' }, lastUsedAt: {} })
    expect(setup(store).reg.assignedNames()).toEqual([])
    store.json = JSON.stringify({ version: 1, assignments: { 'node-a': 'Kevin', 'node-b': 'oliver' }, lastUsedAt: {} })
    const { reg } = setup(store)
    expect(reg.assignedNames()).toEqual(['Oliver'])
    expect(reg.get(node('b'))?.voice).toBe('am_adam')
  })
})
