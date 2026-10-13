import { describe, expect, it } from 'vitest'
import type { HoldState } from './held-microphone'
import { installReadyCue } from './ready-cue'

function setup() {
  let listener: (state: HoldState) => void = () => {}
  let plays = 0
  const uninstall = installReadyCue((fn) => { listener = fn; return () => { listener = () => {} } }, () => { plays++ })
  return { go: (...states: HoldState[]) => { for (const s of states) listener(s) }, plays: () => plays, uninstall }
}

describe('installReadyCue', () => {
  it('sounds once the hold, turned on, is held', () => {
    const t = setup()
    t.go('preparing')
    expect(t.plays()).toBe(0)
    t.go('held')
    expect(t.plays()).toBe(1)
  })

  it('is silent when a stalled microphone comes back', () => {
    const t = setup()
    t.go('preparing', 'held', 'preparing', 'held', 'preparing', 'held')
    expect(t.plays()).toBe(1)
  })

  it('sounds again after being turned off and on', () => {
    const t = setup()
    t.go('preparing', 'held', 'off', 'preparing', 'held')
    expect(t.plays()).toBe(2)
  })

  it('stops when uninstalled', () => {
    const t = setup()
    t.uninstall()
    t.go('preparing', 'held')
    expect(t.plays()).toBe(0)
  })
})
