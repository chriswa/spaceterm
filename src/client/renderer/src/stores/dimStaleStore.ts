import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'
import { DEFAULT_STALE_THRESHOLD_HOURS, normalizeStaleThresholdHours } from '../lib/dim-stale'

const ENABLED_KEY = 'toolbar.dimStale'
const THRESHOLD_KEY = 'toolbar.dimStaleThresholdHours'

interface DimStaleState {
  /** Whether the "dim stale nodes" view is on. */
  enabled: boolean
  toggle: () => void
  /**
   * How much untouched business time a node's subtree gets before it starts to
   * fade, in hours. Chosen from the dim button's menu; persisted.
   */
  thresholdHours: number
  setThresholdHours: (hours: number) => void
  /**
   * Per-node brightness, recomputed by useDimStaleController. Always empty
   * while `enabled` is false, so cards remain at full brightness then.
   */
  nodeBrightness: Map<NodeId, number>
  setNodeBrightness: (brightness: Map<NodeId, number>) => void
}

/** The saved threshold, or the default when nothing usable is stored. */
export function loadThresholdHours(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_STALE_THRESHOLD_HOURS
  return normalizeStaleThresholdHours(Number(raw))
}

export const useDimStaleStore = create<DimStaleState>((set, get) => ({
  // Default OFF: dimming is an opt-in lens, not the resting state.
  enabled: localStorage.getItem(ENABLED_KEY) === 'true',
  toggle: () => {
    const next = !get().enabled
    localStorage.setItem(ENABLED_KEY, String(next))
    set({ enabled: next })
  },
  thresholdHours: loadThresholdHours(localStorage.getItem(THRESHOLD_KEY)),
  setThresholdHours: (hours) => {
    const next = normalizeStaleThresholdHours(hours)
    localStorage.setItem(THRESHOLD_KEY, String(next))
    set({ thresholdHours: next })
  },
  nodeBrightness: new Map(),
  setNodeBrightness: (brightness) => set({ nodeBrightness: brightness }),
}))
