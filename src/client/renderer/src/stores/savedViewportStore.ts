import { create } from 'zustand'
import type { CameraBounds } from './peerStore'

interface SavedViewportState {
  /** slot ('0'..'9') -> canvas-space camera bounds. Mirror of the server's shared set. */
  viewports: Record<string, CameraBounds>
  setAll: (viewports: Record<string, CameraBounds>) => void
}

export const useSavedViewportStore = create<SavedViewportState>((set) => ({
  viewports: {},
  setAll: (viewports) => set({ viewports }),
}))
