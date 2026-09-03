import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'

interface DimStaleState {
  /** Whether the "dim stale nodes" view is on. */
  enabled: boolean
  toggle: () => void
  /**
   * Per-node brightness, recomputed by useDimStaleController. Always empty
   * while `enabled` is false, so cards remain at full brightness then.
   */
  nodeBrightness: Map<NodeId, number>
  setNodeBrightness: (brightness: Map<NodeId, number>) => void
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
  nodeBrightness: new Map(),
  setNodeBrightness: (brightness) => set({ nodeBrightness: brightness }),
}))
