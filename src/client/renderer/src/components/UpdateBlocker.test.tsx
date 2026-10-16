import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { resetUpdateActions, useUpdateActionsStore } from '../stores/updateActionsStore'
import { UpdateBlocker } from './UpdateBlocker'

/**
 * Restarting the server, installing the phone app and reloading the page each
 * let go of Control first, then block the page until it goes — or until the
 * action fails.
 */

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
  vi.stubGlobal('requestAnimationFrame', () => 0)
})

afterEach(() => {
  cleanup()
  act(() => resetUpdateActions())
  vi.unstubAllGlobals()
})

const blocker = () => document.querySelector('.update-blocker')

describe('the update blocker', () => {
  it('is not there while nothing is under way', () => {
    render(<UpdateBlocker />)
    expect(blocker()).toBeNull()
  })

  it.each([
    ['restart', () => useUpdateActionsStore.getState().restart()],
    ['install', () => useUpdateActionsStore.getState().install()],
    ['reload', () => useUpdateActionsStore.getState().reload()],
  ])('%s lets go of Control before anything else', async (kind, start) => {
    // Left pending, as a restart or install is until the page goes.
    bridge.restartSpaceterm = () => new Promise(() => {})
    bridge.installMobileApp = () => new Promise(() => {})
    render(<UpdateBlocker />)
    await act(async () => { void start() })
    expect(bridge.callsTo('receptionist.hold').map((c) => c.args)).toEqual([['release']])
    expect(blocker()?.getAttribute('data-kind')).toBe(kind)
  })

  it('tells an install to wait for the app to be replaced, and cannot be dismissed', async () => {
    bridge.installMobileApp = () => new Promise(() => {})
    render(<UpdateBlocker />)
    await act(async () => { void useUpdateActionsStore.getState().install() })
    expect(screen.getByRole('alertdialog').textContent).toContain('Please wait for the iOS app update')
    expect(screen.getByRole('alertdialog').textContent).toContain('closed and restarted automatically')
    fireEvent.click(blocker()!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(blocker()).not.toBeNull()
  })

  it('stays up for a restart the server took: the page goes, not the screen', async () => {
    render(<UpdateBlocker />)
    await act(async () => { await useUpdateActionsStore.getState().restart() })
    expect(blocker()?.getAttribute('data-kind')).toBe('restart')
  })

  it('comes up on every page for a restart asked for elsewhere, without letting go of Control here', () => {
    render(<UpdateBlocker />)
    act(() => useUpdateActionsStore.getState().serverRestartBegun())
    expect(blocker()?.getAttribute('data-kind')).toBe('restart')
    expect(screen.getByRole('alertdialog').textContent).toContain('Restarting the server')
    expect(bridge.callsTo('receptionist.hold')).toEqual([])
  })

  it('comes down when the restart is refused', async () => {
    bridge.restartSpaceterm = () => Promise.reject(new Error('already in progress'))
    render(<UpdateBlocker />)
    await act(async () => { await useUpdateActionsStore.getState().restart() })
    expect(blocker()).toBeNull()
  })

  it('comes down when the install fails', async () => {
    bridge.installMobileApp = async () => ({ ok: false, message: 'no phone' })
    render(<UpdateBlocker />)
    await act(async () => { await useUpdateActionsStore.getState().install() })
    expect(blocker()).toBeNull()
  })

  it('keeps keys from whatever had focus while it is up', async () => {
    bridge.restartSpaceterm = () => new Promise(() => {})
    const input = document.createElement('input')
    document.body.appendChild(input)
    const heard = vi.fn()
    input.addEventListener('keydown', heard)
    input.focus()
    render(<UpdateBlocker />)
    await act(async () => { void useUpdateActionsStore.getState().restart() })
    expect(document.activeElement).not.toBe(input)
    fireEvent.keyDown(input, { key: 'a' })
    expect(heard).not.toHaveBeenCalled()
    act(() => resetUpdateActions())
    fireEvent.keyDown(input, { key: 'a' })
    expect(heard).toHaveBeenCalledTimes(1)
    input.remove()
  })
})
