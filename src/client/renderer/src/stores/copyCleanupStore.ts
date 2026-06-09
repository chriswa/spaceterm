import { create } from 'zustand'

interface CopyCleanupState {
  enabled: boolean
  toggle: () => void
}

const stored = localStorage.getItem('toolbar.copyCleanup')

export const useCopyCleanupStore = create<CopyCleanupState>((set, get) => ({
  // Default ON: cleanup is the desired behaviour. Toggle off to capture raw
  // terminal selections (e.g. building fixtures for cleanTerminalCopy tests).
  enabled: stored === null ? true : stored === 'true',
  toggle: () => {
    const next = !get().enabled
    localStorage.setItem('toolbar.copyCleanup', String(next))
    set({ enabled: next })
  }
}))
