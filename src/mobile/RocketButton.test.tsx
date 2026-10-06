import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import { useClientStalenessStore } from '@/stores/clientStalenessStore'
import { RocketButton } from './RocketButton'

afterEach(() => {
  cleanup()
  act(() => {
    useRestartRequiredStore.getState().set(false, '')
    useClientStalenessStore.getState().set({ web: false, native: false })
  })
})

const sparks = () => document.querySelector('.m-rocket__sparks')

describe('RocketButton', () => {
  it('has no sparks while everything is up to date', () => {
    render(<RocketButton />)
    expect(sparks()).toBeNull()
  })

  it.each([
    ['a flagged server restart', () => useRestartRequiredStore.getState().set(true, 'x')],
    ['a newer app', () => useClientStalenessStore.getState().set({ web: false, native: true })],
    ['a newer page', () => useClientStalenessStore.getState().set({ web: true, native: false })]
  ])('sparks for %s', (_what, raise) => {
    render(<RocketButton />)
    act(raise)
    expect(sparks()).not.toBeNull()
    expect(screen.getByRole('button', { name: /updates waiting/ })).toBeTruthy()
  })
})
