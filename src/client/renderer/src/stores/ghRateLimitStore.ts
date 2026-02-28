import { create } from 'zustand'
import type { GhRateLimitData } from '../../../../shared/protocol'

interface GhRateLimitState {
  data: GhRateLimitData | null
  usedHistory: (number | null)[]
  update: (data: GhRateLimitData, usedHistory: (number | null)[]) => void
}

export const useGhRateLimitStore = create<GhRateLimitState>((set) => ({
  data: null,
  usedHistory: [],
  update: (data, usedHistory) => set({ data, usedHistory }),
}))
