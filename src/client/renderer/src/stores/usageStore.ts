import { create } from 'zustand'
import type { ClaudeUsageData } from '../../../../server/claude-usage'

interface UsageState {
  usage: ClaudeUsageData | null
  subscriptionType: string | null
  rateLimitTier: string | null
  update: (usage: ClaudeUsageData, subscriptionType: string, rateLimitTier: string) => void
}

export const useUsageStore = create<UsageState>((set) => ({
  usage: null,
  subscriptionType: null,
  rateLimitTier: null,
  update: (usage, subscriptionType, rateLimitTier) => set({ usage, subscriptionType, rateLimitTier }),
}))
