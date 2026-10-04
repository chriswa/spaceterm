import { create } from 'zustand'
import type { ReceptionistStatus, SummaryChatPhase } from '../../../../shared/api'
import type { ReceptionistHolder } from '../../../../shared/state'

/** Who holds Control, as this client sees it. */
export interface ReceptionistHolding {
  /** What the holding device is called, e.g. "Phone". */
  label: string
  /** Whether it is this client's device. */
  mine: boolean
}

/**
 * The Control button's three states, the same on every client: `away` (black)
 * while another device or none holds Control, `here` (white) while this one
 * does and the voice goes to it, `summary` (magenta) while this one does but
 * the voice last went to Summary Chat. A press moves `away` and `summary` to
 * `here`, and `here` to `away` — see `ReceptionistSelectMessage`.
 */
export type ControlLook = 'away' | 'here' | 'summary'

export function controlLook(holder: ReceptionistHolding | null, target: boolean): ControlLook {
  if (!holder?.mine) return 'away'
  return target ? 'here' : 'summary'
}

interface ReceptionistState {
  /** What the receptionist is doing. Server-owned, the same on every client. */
  phase: SummaryChatPhase
  /** Whether the listener's voice goes to the receptionist rather than Summary Chat. */
  target: boolean
  /** Why it last failed, while it stays failed. */
  error: string | null
  /** The device Control speaks to, or null when nobody holds it. Mirrors `ServerState.receptionistHolder`. */
  holder: ReceptionistHolding | null
  setStatus: (status: ReceptionistStatus) => void
  /** `deviceId` is this client's own. */
  setHolder: (holder: ReceptionistHolder | null, deviceId: string) => void
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
  holder: null,
  setStatus: ({ phase, target, message }) => set({ phase, target, error: message ?? null }),
  setHolder: (holder, deviceId) => set({ holder: holder && { label: holder.label, mine: holder.deviceId === deviceId } }),
}))
