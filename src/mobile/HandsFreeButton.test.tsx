import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { installHandsFree, macHandsFreeLink, realHandsFreeDeps, setHandsFree, useHandsFree } from './hands-free'
import { HandsFreeButton } from './HandsFreeButton'

// The Mac's toolbar button: it switches Voice Operator's hands-free on the
// Mac's own microphone (desktop-hands-free.ts), not a hold.

let uninstall: () => void
let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  uninstall = installHandsFree(realHandsFreeDeps(window.api, macHandsFreeLink(window.api.handsFree)))
})

afterEach(() => {
  cleanup()
  setHandsFree(false)
  uninstall()
})

describe('the hands-free button on the Mac', () => {
  it('sits in the toolbar as one of its buttons, with a tooltip saying what it does', () => {
    render(<HandsFreeButton chrome="toolbar" />)
    const button = screen.getByRole('button', { name: 'Hands-free: always listen for "Control"' })
    expect(button.classList).toContain('toolbar__btn')
    expect(button.classList).toContain('toolbar__hands-free')
    expect(button.classList).not.toContain('m-bar__button')
    expect(button.getAttribute('data-tooltip')).toBe(button.getAttribute('aria-label'))
  })

  it('switches hands-free on with a click, and off with the next', () => {
    render(<HandsFreeButton chrome="toolbar" />)
    const button = screen.getByRole('button', { name: /always listen/ })
    fireEvent.click(button)
    expect(useHandsFree.getState().on).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toMatch(/click to stop$/)
    expect(button.getAttribute('data-tooltip')).toBe(button.getAttribute('aria-label'))
    fireEvent.click(button)
    expect(useHandsFree.getState().on).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(bridge.calls.filter((c) => c.method === 'handsFree.setMac').map((c) => c.args)).toEqual([[true], [false]])
  })

  it('strikes the ear through while our own voice plays out loud, and says so', () => {
    render(<HandsFreeButton chrome="toolbar" />)
    const button = screen.getByRole('button', { name: /always listen/ })
    fireEvent.click(button)
    const state = (extra: Record<string, unknown>) => act(() => bridge.emit.handsFreeMacEvent(
      { type: 'state', phase: 'listening', conversation: false, closesAt: null, checking: false, pending: false, ...extra }))
    state({ standingAside: 'speech' })
    expect(button.classList).toContain('m-hands-free--deaf')
    expect(button.querySelector('.m-hands-free__strike')).not.toBeNull()
    expect(button.getAttribute('aria-label')).toMatch(/^Hands-free: not listening while our voice plays out loud/)
    expect(button.getAttribute('data-tooltip')).toBe(button.getAttribute('aria-label'))
    // A Fn dictation shows elsewhere; and once it listens again the ear is whole.
    state({ standingAside: 'dictation' })
    expect(button.classList).not.toContain('m-hands-free--deaf')
    state({ standingAside: 'speech' })
    state({ standingAside: null })
    expect(button.classList).not.toContain('m-hands-free--deaf')
    expect(button.querySelector('.m-hands-free__strike')).toBeNull()
    expect(button.getAttribute('aria-label')).toMatch(/always listening for "Control"/)
  })

  it('does nothing when hands-free cannot run on this Mac, and says why', () => {
    render(<HandsFreeButton chrome="toolbar" unavailable="Hands-free needs macOS 26" />)
    const button = screen.getByRole('button', { name: 'Hands-free needs macOS 26' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('data-tooltip')).toBe('Hands-free needs macOS 26')
    fireEvent.click(button)
    expect(useHandsFree.getState().on).toBe(false)
  })

  it('is the phone\'s button, as the phone draws it, without the toolbar\'s chrome', () => {
    render(<HandsFreeButton />)
    // A browser on the phone: no app, so a held microphone rather than hands-free.
    const button = screen.getByRole('button', { name: /Hold the microphone open/ })
    expect(button.classList).toContain('m-bar__button')
    expect(button.hasAttribute('data-tooltip')).toBe(false)
  })
})
