import { create } from 'zustand'

const CAPTURE_DURATION_MS = 5_000

interface PerfState {
  recording: 'idle' | 'trace'
  startTrace: () => void
}

export const usePerfStore = create<PerfState>((set, get) => ({
  recording: 'idle',

  startTrace: async () => {
    if (get().recording !== 'idle') return
    set({ recording: 'trace' })
    try {
      await window.api.perf.startTrace()
      await new Promise(r => setTimeout(r, CAPTURE_DURATION_MS))
      const path = await window.api.perf.stopTrace()
      window.api.log(`Content trace complete: ${path} (copied to clipboard)`)
    } catch (err) {
      window.api.log(`Content trace failed: ${err}`)
    }
    set({ recording: 'idle' })
  },
}))
