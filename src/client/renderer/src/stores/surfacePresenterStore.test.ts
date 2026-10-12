import { describe, it, expect } from 'vitest'
import { useSurfacePresenterStore } from './surfacePresenterStore'
import { asNodeId } from '../../../../shared/ids'

describe('focus requests', () => {
  it('are cleared once taken, so a remounted canvas does not act on them again', () => {
    const store = useSurfacePresenterStore.getState()
    store.requestFocus(asNodeId('a'))
    const first = useSurfacePresenterStore.getState().focusRequest!
    store.clearFocusRequest(first.seq)
    expect(useSurfacePresenterStore.getState().focusRequest).toBeNull()
  })

  it('leave a newer request alone, and never reuse a number', () => {
    const store = useSurfacePresenterStore.getState()
    store.requestFocus(asNodeId('a'))
    const first = useSurfacePresenterStore.getState().focusRequest!
    store.clearFocusRequest(first.seq)
    store.requestFocus(asNodeId('b'))
    const second = useSurfacePresenterStore.getState().focusRequest!
    expect(second.seq).toBeGreaterThan(first.seq)
    store.clearFocusRequest(first.seq)
    expect(useSurfacePresenterStore.getState().focusRequest).toEqual(second)
  })
})
