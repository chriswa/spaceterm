import { create } from 'zustand'

interface AutoStampsEnabledState {
  /** Mirror of `ServerState.autoStampsEnabled`, which every client shares. */
  enabled: boolean
  set: (enabled: boolean) => void
}

/**
 * Whether the server draws auto-stamp icons. Server-owned, unlike the other
 * toolbar toggles: the setting decides what the server spends, so it is the
 * same for every client and a change from one is pushed to the rest.
 */
export const useAutoStampsEnabledStore = create<AutoStampsEnabledState>((set) => ({
  enabled: true,
  set: (enabled) => set({ enabled }),
}))
