import { describe, expect, it } from 'vitest'
import { asNodeId } from '../../shared/ids'
import { ADJECTIVES, baseHandle, DIRECTORY_PREFIX, Handles, NOUNS } from './handles'
import { NAME_VOICE_TABLE } from './name-voice-table'

const ids = Array.from({ length: 40 }, (_, i) => asNodeId(`${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`))

describe('handle words', () => {
  it('are distinct by their first three letters, so one cannot be garbled into another', () => {
    for (const list of [ADJECTIVES, NOUNS]) {
      const prefixes = list.map(word => word.slice(0, 3))
      expect(new Set(prefixes).size, prefixes.filter((p, i) => prefixes.indexOf(p) !== i).join(', ')).toBe(list.length)
    }
  })

  it('never use a name from the voice roster', () => {
    const names = new Set(NAME_VOICE_TABLE.map(entry => entry.name.toLowerCase()))
    expect([...ADJECTIVES, ...NOUNS].filter(word => names.has(word))).toEqual([])
  })
})

describe('Handles', () => {
  it('gives every node a stable word pair', () => {
    expect(baseHandle(ids[0])).toBe(baseHandle(ids[0]))
    expect(baseHandle(ids[0])).toMatch(/^[a-z]+-[a-z]+$/)
    const handles = new Handles(ids)
    expect(handles.of(ids[3])).toBe(new Handles([...ids].reverse()).of(ids[3]))
  })

  it('keeps handles distinct among the nodes it was given, finding each back', () => {
    const handles = new Handles(ids)
    const all = ids.map(id => handles.of(id)!)
    expect(new Set(all).size).toBe(ids.length)
    for (const id of ids) expect(handles.find(handles.of(id)!)).toBe(id)
    expect(handles.find(` ${handles.of(ids[0])!.toUpperCase()} `)).toBe(ids[0])
  })

  it('resolves a collision by node id order with a -2', () => {
    // Find two ids whose pairs collide by brute force over a small search.
    const seen = new Map<string, ReturnType<typeof asNodeId>>()
    let pair: [ReturnType<typeof asNodeId>, ReturnType<typeof asNodeId>] | undefined
    for (let i = 0; !pair && i < 200_000; i++) {
      const id = asNodeId(`n${i}`)
      const base = baseHandle(id)
      const other = seen.get(base)
      if (other) pair = [other, id]
      seen.set(base, id)
    }
    const [a, b] = pair!
    const handles = new Handles([b, a])
    const [first, second] = [a, b].sort()
    expect(handles.of(first)).toBe(baseHandle(a))
    expect(handles.of(second)).toBe(`${baseHandle(a)}-2`)
  })

  it('suggests the nearest real handle for a mistyped one', () => {
    const handles = new Handles(ids)
    const real = handles.of(ids[5])!
    const typo = real.replace(/.$/, c => (c === 'x' ? 'y' : 'x'))
    expect(handles.nearest(typo)[0]).toBe(real)
    expect(handles.nearest('completely-unrelated-words-here')).toEqual([])
  })

  it('prefixes directory handles so they never look like an agent', () => {
    expect(new Handles([ids[0]], DIRECTORY_PREFIX).of(ids[0])).toMatch(/^dir-[a-z]+-[a-z]+$/)
  })
})
