import { create } from 'zustand'

const STORAGE_KEY = 'toolbar.powerMonitor'

interface PowerMonitorState {
  enabled: boolean
  toggle: () => void
}

/**
 * Whether the toolbar shows the GPU/CPU/watts readout.
 *
 * Off by default and persisted, because the readout is diagnostic scaffolding
 * for comparing canvas themes rather than something the toolbar should carry
 * forever — and because sampling it spawns `ioreg` once a second, which is a
 * cost nobody should pay for a number they are not reading.
 */
export const usePowerMonitorStore = create<PowerMonitorState>((set, get) => ({
  enabled: localStorage.getItem(STORAGE_KEY) === 'true',
  toggle: () => {
    const next = !get().enabled
    localStorage.setItem(STORAGE_KEY, String(next))
    set({ enabled: next })
  }
}))
