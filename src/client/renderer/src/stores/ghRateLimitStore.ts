import { create } from 'zustand'
import type { GhRateLimitData } from '../../../../shared/protocol'

interface GhRateLimitState {
  data: GhRateLimitData | null
  usedHistory: (number | null)[]
  slotMinutes: number
  update: (data: GhRateLimitData, usedHistory: (number | null)[], slotMinutes: number) => void
}

export const useGhRateLimitStore = create<GhRateLimitState>((set) => ({
  data: null,
  usedHistory: [],
  slotMinutes: 1,
  update: (data, usedHistory, slotMinutes) => set({ data, usedHistory, slotMinutes }),
}))
