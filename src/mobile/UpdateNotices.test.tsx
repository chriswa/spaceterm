import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import { useClientStalenessStore } from '@/stores/clientStalenessStore'
import { resetUpdateActions } from '@/stores/updateActionsStore'
import { EMPTY_APPROVALS, useApprovalsStore } from './approvals-store'
import { NotificationsButton } from './NotificationsButton'
import { NotificationsSheet } from './NotificationsSheet'

/** Updates waiting to be done are notifications: on the bell, and a row in its list that does them. */

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
})

afterEach(() => {
  cleanup()
  act(() => {
    useRestartRequiredStore.getState().set(false, '')
    useClientStalenessStore.getState().set({ web: false, native: false })
    useApprovalsStore.setState({ snapshot: EMPTY_APPROVALS, seen: new Set(), listOpen: false, openKey: null })
    resetUpdateActions()
  })
})

const bell = () => document.querySelector('.m-bell')!

describe('update notices', () => {
  it.each([
    ['a flagged server restart', () => useRestartRequiredStore.getState().set(true, 'x')],
    ['a newer app', () => useClientStalenessStore.getState().set({ web: false, native: true })],
    ['a newer page', () => useClientStalenessStore.getState().set({ web: true, native: false })]
  ])('light the bell, unread, for %s', (_what, raise) => {
    render(<NotificationsButton />)
    expect(bell().className).toContain('m-bell--idle')
    act(raise)
    expect(bell().className).toContain('m-bell--info')
    expect(bell().className).toContain('m-bell--unread')
    expect(screen.getByRole('button', { name: /1 waiting, 1 new/ })).toBeTruthy()
  })

  it('are read once the list has shown them, including one raised while it is up', () => {
    act(() => useRestartRequiredStore.getState().set(true, 'x'))
    render(<NotificationsButton />)
    fireEvent.click(bell())
    expect(bell().className).not.toContain('m-bell--unread')
    render(<NotificationsSheet />)
    act(() => useClientStalenessStore.getState().set({ web: false, native: true }))
    expect(bell().className).not.toContain('m-bell--unread')
    expect(bell().className).toContain('m-bell--info')
  })

  it('shows the restart with its reason, and restarts from its button once', () => {
    bridge.restartSpaceterm = vi.fn(() => new Promise<void>(() => undefined))
    act(() => useRestartRequiredStore.getState().set(true, 'protocol changed'))
    render(<NotificationsSheet />)
    expect(screen.getByText('protocol changed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    const busy = screen.getByRole('button', { name: 'Restarting…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(busy)
    expect(bridge.restartSpaceterm).toHaveBeenCalledTimes(1)
  })

  it('does not ask for a reload beside a restart, which reloads anyway', () => {
    act(() => {
      useRestartRequiredStore.getState().set(true, '')
      useClientStalenessStore.getState().set({ web: true, native: false })
    })
    render(<NotificationsSheet />)
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
  })
})
