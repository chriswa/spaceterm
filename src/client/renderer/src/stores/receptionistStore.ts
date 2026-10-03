import { create } from 'zustand'
import type { ReceptionistStatus, SummaryChatPhase } from '../../../../shared/api'

interface ReceptionistState {
  /** What the receptionist is doing. Server-owned, the same on every client. */
  phase: SummaryChatPhase
  /** Whether the listener's voice goes to the receptionist rather than Summary Chat. */
  target: boolean
  /** Why it last failed, while it stays failed. */
  error: string | null
  /** Whether it may speak up unprompted. Mirrors `ServerState.receptionistTalkToMe`, on unless turned off. */
  talkToMe: boolean
  setStatus: (status: ReceptionistStatus) => void
  setTalkToMe: (enabled: boolean) => void
}

/**
 * Mirror of the receptionist ("Control") as the server last described it.
 * Nothing here is decided by the client: a press asks the server, and the
 * store follows the `receptionist-status` broadcast that answers it.
 */
export const useReceptionistStore = create<ReceptionistState>((set) => ({
  phase: 'ready',
  target: false,
  error: null,
  talkToMe: true,
  setStatus: ({ phase, target, message }) => set({ phase, target, error: message ?? null }),
  setTalkToMe: (talkToMe) => set({ talkToMe }),
}))
