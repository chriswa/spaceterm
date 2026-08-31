import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'

interface DimStaleState {
  /** Whether the "dim stale nodes" view is on. */
  enabled: boolean
  toggle: () => void
  /**
   * Node ids to dim, recomputed by useDimStaleController. Always empty while
   * `enabled` is false, so a subscriber can key dimming off membership alone.
   */
  staleIds: Set<NodeId>
  setStaleIds: (ids: Set<NodeId>) => void
}

const stored = localStorage.getItem('toolbar.dimStale')

export const useDimStaleStore = create<DimStaleState>((set, get) => ({
  // Default OFF: dimming is an opt-in lens, not the resting state.
  enabled: stored === 'true',
  toggle: () => {
    const next = !get().enabled
    localStorage.setItem('toolbar.dimStale', String(next))
    set({ enabled: next })
  },
  staleIds: new Set(),
  setStaleIds: (ids) => set({ staleIds: ids }),
}))
