import { create } from 'zustand'

interface EdgesState {
  edgesEnabled: boolean
  toggle: () => void
}

export const useEdgesStore = create<EdgesState>((set) => ({
  edgesEnabled: true,
  toggle: () => set((s) => ({ edgesEnabled: !s.edgesEnabled })),
}))
