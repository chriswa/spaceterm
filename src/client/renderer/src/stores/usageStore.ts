import { create } from 'zustand'
import type { ClaudeUsageData } from '../../../../server/claude-usage'

interface UsageState {
  usage: ClaudeUsageData | null
  subscriptionType: string | null
  rateLimitTier: string | null
  creditHistory: (number | null)[]
  update: (usage: ClaudeUsageData, subscriptionType: string, rateLimitTier: string, creditHistory: (number | null)[]) => void
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: null,
  subscriptionType: null,
  rateLimitTier: null,
  creditHistory: [],
  update: (usage, subscriptionType, rateLimitTier, creditHistory) =>
    set({ usage, subscriptionType, rateLimitTier, creditHistory }),
}))
