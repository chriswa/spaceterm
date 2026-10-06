import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge } from '../../testing/fake-bridge'
import { InstallAppButton, ReloadClientButton } from './buttons'
import { useRestartRequiredStore } from '../../stores/restartRequiredStore'
import { useClientStalenessStore, pendingUpdates } from '../../stores/clientStalenessStore'

/**
 * The phone's update buttons in the toolbar sheet: always there, and marching
 * their ants while what they do is waiting to be done.
 */

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  act(() => {
    useRestartRequiredStore.getState().set(false, '')
    useClientStalenessStore.getState().set({ web: false, native: false })
  })
})

describe('pendingUpdates', () => {
  it('asks for a reload only when nothing bigger is waiting', () => {
    expect(pendingUpdates({ restart: false, native: false, web: true })).toEqual({ restart: false, install: false, reload: true })
    // The restarted server reloads every client anyway.
    expect(pendingUpdates({ restart: true, native: false, web: true })).toEqual({ restart: true, install: false, reload: false })
    // The new app loads the new page; and the app is asked for beside a restart.
    expect(pendingUpdates({ restart: true, native: true, web: true })).toEqual({ restart: true, install: true, reload: false })
    expect(pendingUpdates({ restart: false, native: false, web: false })).toEqual({ restart: false, install: false, reload: false })
  })
})

describe('ReloadClientButton', () => {
  it('marches when the page is behind, unless a server restart is waiting', () => {
    render(<ReloadClientButton />)
    const btn = screen.getByRole('button', { name: 'Reload client' })
    expect(btn.className).not.toContain('toolbar__btn--pending')
    act(() => useClientStalenessStore.getState().set({ web: true, native: false }))
    expect(btn.className).toContain('toolbar__btn--pending')
    act(() => useRestartRequiredStore.getState().set(true, 'protocol changed'))
    expect(btn.className).not.toContain('toolbar__btn--pending')
  })

  it('reloads two frames after the tap, so the pressed state is painted first', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length })
    render(<ReloadClientButton />)
    const btn = screen.getByRole('button', { name: 'Reload client' })
    fireEvent.click(btn)
    expect(btn.className).toContain('toolbar__btn--active')
    expect(frames).toHaveLength(1)
  })
})

describe('InstallAppButton', () => {
  it('marches when the app is behind, even beside a restart', () => {
    act(() => {
      useRestartRequiredStore.getState().set(true, 'x')
      useClientStalenessStore.getState().set({ web: true, native: true })
    })
    render(<InstallAppButton />)
    expect(screen.getByRole('button', { name: 'Install the app' }).className).toContain('toolbar__btn--pending')
  })

  it('stays busy while the Mac installs, starts nothing more, and comes back on a failure', async () => {
    const bridge = installFakeBridge()
    let answer: (outcome: { ok: boolean; message?: string }) => void = () => undefined
    bridge.installMobileApp = vi.fn(() => new Promise<{ ok: boolean; message?: string }>((resolve) => { answer = resolve }))
    render(<InstallAppButton />)
    const btn = screen.getByRole('button', { name: 'Install the app' }) as HTMLButtonElement
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(bridge.installMobileApp).toHaveBeenCalledTimes(1)
    expect(btn.disabled).toBe(true)
    await act(async () => answer({ ok: false, message: 'No paired iPhone found.' }))
    expect(btn.disabled).toBe(false)
  })
})
