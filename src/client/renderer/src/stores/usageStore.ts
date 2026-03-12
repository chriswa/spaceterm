import { create } from 'zustand'
import type { ClaudeUsageData } from '../../../../server/claude-usage'

interface UsageState {
  usage: ClaudeUsageData | null
  subscriptionType: string | null
  rateLimitTier: string | null
  usageError: string | null
  creditHistory: (number | null)[]
  fiveHourHistory: (number | null)[]
  sevenDayHistory: (number | null)[]
  slotMinutes: number
  update: (usage: ClaudeUsageData | null, subscriptionType: string | null, rateLimitTier: string | null, usageError: string | null, creditHistory: (number | null)[], fiveHourHistory: (number | null)[], sevenDayHistory: (number | null)[], slotMinutes: number) => void
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: null,
  subscriptionType: null,
  rateLimitTier: null,
  usageError: null,
  creditHistory: [],
  fiveHourHistory: [],
  sevenDayHistory: [],
  slotMinutes: 5,
  update: (usage, subscriptionType, rateLimitTier, usageError, creditHistory, fiveHourHistory, sevenDayHistory, slotMinutes) =>
    set({ usage, subscriptionType, rateLimitTier, usageError, creditHistory, fiveHourHistory: fiveHourHistory ?? [], sevenDayHistory: sevenDayHistory ?? [], slotMinutes }),
}))
