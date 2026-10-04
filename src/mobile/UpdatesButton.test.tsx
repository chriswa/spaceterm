import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import { pendingUpdates, UpdatesButton } from './UpdatesButton'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.spacetermNativeVersion
  act(() => useRestartRequiredStore.getState().set(false, ''))
})

/** The Mac publishes a newer app than this one. */
function behindOnTheApp() {
  window.spacetermNativeVersion = 'old'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: 'w', native: 'new' }))))
}

function upToDate() {
  window.spacetermNativeVersion = 'same'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ native: 'same' }))))
}

describe('pendingUpdates', () => {
  it('puts the restart first, and drops the reload while the app is behind', () => {
    expect(pendingUpdates({ restart: true, native: true, web: true })).toEqual(['restart', 'install'])
    expect(pendingUpdates({ restart: false, native: false, web: true })).toEqual(['reload'])
    expect(pendingUpdates({ restart: false, native: false, web: false })).toEqual([])
  })
})

describe('UpdatesButton', () => {
  it('asks the Mac to install the newer app from the list, spinning until it answers, and shows a failure', async () => {
    behindOnTheApp()
    const bridge = installFakeBridge()
    let answer: (outcome: { ok: boolean; message?: string }) => void = () => undefined
    bridge.installMobileApp = vi.fn(() => new Promise<{ ok: boolean; message?: string }>((resolve) => { answer = resolve }))
    render(<UpdatesButton />)
    const chip = await screen.findByRole('button', { name: 'App update' })

    fireEvent.click(chip)
    const install = screen.getByRole('button', { name: /Install/ })
    fireEvent.click(install)
    expect(bridge.installMobileApp).toHaveBeenCalledTimes(1)
    expect(chip.className).toContain('m-updates--busy')
    // A second tap while it builds starts nothing more.
    fireEvent.click(install)
    expect(bridge.installMobileApp).toHaveBeenCalledTimes(1)

    await act(async () => answer({ ok: false, message: 'No paired iPhone found.' }))
    expect(screen.getByRole('alert').textContent).toBe('No paired iPhone found.')
    expect(chip.className).not.toContain('m-updates--busy')
  })

  it('shows a flagged server restart with its reason, and goes when the flag clears', async () => {
    upToDate()
    const bridge = installFakeBridge()
    bridge.restartSpaceterm = vi.fn(async () => undefined)
    act(() => useRestartRequiredStore.getState().set(true, 'protocol changed'))
    const { container } = render(<UpdatesButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Server restart needed' }))
    expect(screen.getByText('protocol changed')).toBeTruthy()
    const chip = screen.getByRole('button', { name: 'Server restart needed' })
    fireEvent.click(screen.getByRole('button', { name: /Restart/ }))
    expect(bridge.restartSpaceterm).toHaveBeenCalledTimes(1)
    // Shows at once, and stays restarting once the server has taken it: the
    // page reloads when the server is back.
    expect(screen.getByText('Restarting…')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Restarting…')).toBeTruthy()
    expect(chip.className).toContain('m-updates--busy')

    act(() => useRestartRequiredStore.getState().set(false, ''))
    expect(container.innerHTML).toBe('')
  })

  it('shows a reload at once, before the page goes', async () => {
    window.spacetermNativeVersion = 'same'
    vi.stubGlobal('__MOBILE_BUILD_ID__', 'older')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: 'newer', native: 'same' }))))
    installFakeBridge()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length })
    render(<UpdatesButton />)
    fireEvent.click(await screen.findByRole('button', { name: 'Newer page' }))
    fireEvent.click(screen.getByRole('button', { name: /Reload/ }))
    expect(screen.getByText('Reloading…')).toBeTruthy()
    // The reload itself waits two frames, for that to be painted.
    expect(frames).toHaveLength(1)
  })

  it('shows nothing when everything is up to date', async () => {
    upToDate()
    installFakeBridge()
    const { container } = render(<UpdatesButton />)
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
  })
})
