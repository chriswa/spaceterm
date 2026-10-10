import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import { useClientStalenessStore } from '@/stores/clientStalenessStore'
import { resetUpdateActions } from '@/stores/updateActionsStore'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useNoticesRead } from './update-notices'
import { RocketButton } from './RocketButton'

/**
 * Updates waiting to be done count on the rocket; the sheet it opens does them
 * with the strip's own marching buttons.
 */

beforeEach(() => {
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  act(() => {
    useRestartRequiredStore.getState().set(false, '')
    useClientStalenessStore.getState().set({ web: false, native: false })
    useNoticesRead.setState({ seen: new Set() })
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
    resetUpdateActions()
  })
})

const rocket = () => document.querySelector('.m-rocket')!

describe('update notices', () => {
  it.each([
    ['a flagged server restart', () => useRestartRequiredStore.getState().set(true, 'x')],
    ['a newer app', () => useClientStalenessStore.getState().set({ web: false, native: true })],
    ['a newer page', () => useClientStalenessStore.getState().set({ web: true, native: false })]
  ])('count on the rocket, unread, for %s', (_what, raise) => {
    render(<RocketButton />)
    expect(rocket().className).not.toContain('m-rocket--info')
    act(raise)
    expect(rocket().className).toContain('m-rocket--info')
    expect(rocket().className).toContain('m-rocket--unread')
    expect(screen.getByRole('button', { name: /1 waiting, 1 new/ })).toBeTruthy()
  })

  it('are read once the sheet has shown them, including one raised while it is up', () => {
    act(() => useRestartRequiredStore.getState().set(true, 'x'))
    render(<RocketButton />)
    fireEvent.click(rocket())
    expect(rocket().className).not.toContain('m-rocket--unread')
    act(() => useClientStalenessStore.getState().set({ web: false, native: true }))
    expect(rocket().className).not.toContain('m-rocket--unread')
    expect(rocket().className).toContain('m-rocket--info')
  })
})
