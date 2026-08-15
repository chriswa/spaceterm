import { create } from 'zustand'
import { setUnfocusedFrames, unfocusedFrames, type UnfocusedFrames } from '../lib/frame-policy'

/**
 * What the app does with frames while it is not the focused window.
 *
 * The store is the persistence and the React binding; `frame-policy` is the
 * thing render loops actually read, and is deliberately not a store — a loop
 * that has to subscribe to a hook to find out how fast to run is a loop that
 * re-renders to change speed.
 *
 * Default `reduced`, which still draws — see `UnfocusedFrames` for why pausing
 * an unfocused window is the wrong default when one of them might be the
 * display you are watching.
 */
const STORAGE_KEY = 'toolbar.unfocusedFrames'

const stored = localStorage.getItem(STORAGE_KEY)
const initial: UnfocusedFrames = stored === 'full' ? 'full' : 'reduced'
// Push before the first render: a loop can start before any component mounts.
setUnfocusedFrames(initial)

interface FramePolicyState {
  unfocused: UnfocusedFrames
  toggle: () => void
}

export const useFramePolicyStore = create<FramePolicyState>((set, get) => ({
  unfocused: unfocusedFrames(),
  toggle: () => {
    const next: UnfocusedFrames = get().unfocused === 'full' ? 'reduced' : 'full'
    localStorage.setItem(STORAGE_KEY, next)
    setUnfocusedFrames(next)
    set({ unfocused: next })
  }
}))
