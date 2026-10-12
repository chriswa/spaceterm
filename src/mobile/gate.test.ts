import { describe, it, expect } from 'vitest'
import { createGate, anyOf, not, whileOn } from './gate'

describe('createGate', () => {
  it('tells listeners of changes only', () => {
    const gate = createGate(false)
    const seen: boolean[] = []
    gate.subscribe((on) => seen.push(on))
    gate.set(false)
    gate.set(true)
    gate.set(true)
    gate.set(false)
    expect(seen).toEqual([true, false])
  })
})

describe('anyOf and not', () => {
  it('is on while any input is', () => {
    const a = createGate(false)
    const b = createGate(false)
    const either = anyOf(a, b)
    const seen: boolean[] = []
    either.subscribe((on) => seen.push(on))
    a.set(true)
    b.set(true)
    a.set(false)
    expect(either.on).toBe(true)
    b.set(false)
    expect(seen).toEqual([true, false])
  })

  it('inverts', () => {
    const a = createGate(true)
    const inverse = not(a)
    expect(inverse.on).toBe(false)
    a.set(false)
    expect(inverse.on).toBe(true)
  })
})

describe('whileOn', () => {
  it('starts with the gate and stops with it', () => {
    const gate = createGate(true)
    const log: string[] = []
    const uninstall = whileOn(gate, () => { log.push('start'); return () => log.push('stop') })
    gate.set(false)
    gate.set(true)
    uninstall()
    gate.set(false)
    gate.set(true)
    expect(log).toEqual(['start', 'stop', 'start', 'stop'])
  })

  it('does not start while the gate is off', () => {
    const gate = createGate(false)
    let started = 0
    whileOn(gate, () => { started++; return () => undefined })
    expect(started).toBe(0)
  })
})
