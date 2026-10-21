import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { holdState, installHeldMicrophone, setHoldMicrophone } from './held-microphone'
import { HandsFreeButton } from './HandsFreeButton'

// The Mac's toolbar button. A file of its own: the hold's host is set once
// per page, and the phone's tests (MicButton.test.tsx) run as the phone.

let uninstall: () => void

beforeEach(() => {
  installFakeBridge()
  uninstall = installHeldMicrophone('desktop')
})

afterEach(() => {
  cleanup()
  setHoldMicrophone(false)
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
    expect(holdState()).not.toBe('off')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('aria-label')).toMatch(/click to stop$/)
    expect(button.getAttribute('data-tooltip')).toBe(button.getAttribute('aria-label'))
    fireEvent.click(button)
    expect(holdState()).toBe('off')
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  it('does nothing when hands-free cannot run on this Mac, and says why', () => {
    render(<HandsFreeButton chrome="toolbar" unavailable="Hands-free needs macOS 26" />)
    const button = screen.getByRole('button', { name: 'Hands-free needs macOS 26' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('data-tooltip')).toBe('Hands-free needs macOS 26')
    fireEvent.click(button)
    expect(holdState()).toBe('off')
  })

  it('is the phone\'s button, as the phone draws it, without the toolbar\'s chrome', () => {
    render(<HandsFreeButton />)
    const button = screen.getByRole('button', { name: /always listen/ })
    expect(button.classList).toContain('m-bar__button')
    expect(button.hasAttribute('data-tooltip')).toBe(false)
  })
})
