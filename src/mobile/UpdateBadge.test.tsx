import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { UpdateBadge } from './UpdateBadge'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.spacetermNativeVersion
})

/** The Mac publishes a newer app than this one. */
function behindOnTheApp() {
  window.spacetermNativeVersion = 'old'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ web: 'w', native: 'new' }))))
}

describe('UpdateBadge', () => {
  it('asks the Mac to install the newer app, spinning until it answers, and shows a failure', async () => {
    behindOnTheApp()
    const bridge = installFakeBridge()
    let answer: (outcome: { ok: boolean; message?: string }) => void = () => undefined
    bridge.installMobileApp = vi.fn(() => new Promise<{ ok: boolean; message?: string }>((resolve) => { answer = resolve }))
    render(<UpdateBadge />)
    const badge = await screen.findByRole('button', { name: /Install the newer app/ })

    fireEvent.click(badge)
    expect(bridge.installMobileApp).toHaveBeenCalledTimes(1)
    expect(badge.className).toContain('m-update--busy')
    // A second tap while it builds starts nothing more.
    fireEvent.click(badge)
    expect(bridge.installMobileApp).toHaveBeenCalledTimes(1)

    await act(async () => answer({ ok: false, message: 'No paired iPhone found.' }))
    expect(screen.getByRole('alert').textContent).toBe('No paired iPhone found.')
    expect(badge.className).not.toContain('m-update--busy')
  })

  it('shows nothing when the phone is up to date', async () => {
    window.spacetermNativeVersion = 'same'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ native: 'same' }))))
    installFakeBridge()
    const { container } = render(<UpdateBadge />)
    await act(async () => { await Promise.resolve() })
    expect(container.innerHTML).toBe('')
  })
})
