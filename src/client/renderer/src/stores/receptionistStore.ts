import { create } from 'zustand'
import type { ReceptionistStatus, SummaryChatPhase } from '../../../../shared/api'
import type { ReceptionistHolder } from '../../../../shared/state'

/** Who holds Control, as this client sees it. */
export interface ReceptionistHolding {
  /** What the holding device is called, e.g. "Phone". */
  label: string
  /** Whether it is this client's device. */
  mine: boolean
  /** Control writes to that device rather than speaking. */
  muted: boolean
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
  /**
   * This device has muted Control, whether or not it holds it: taking Control
   * brings it here muted. Mirrors `ServerState.receptionistMuted`.
   */
  mutedHere: boolean
  /** Who is being heard while it speaks: "Control", or the agent it quotes. */
  speaker: string | null
  /** Replies written to a muted device and not read yet, and where the oldest is in the record. */
  unread: { count: number; first?: number }
  setStatus: (status: ReceptionistStatus) => void
  setUnread: (unread: { count: number; first?: number }) => void
  /**
   * `deviceId` is this client's own; `muted`, the devices that muted Control,
   * absent from a server too old to say — then only the holder's mute is known.
   */
  setHolder: (holder: ReceptionistHolder | null, deviceId: string, muted?: string[]) => void
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
  mutedHere: false,
  speaker: null,
  unread: { count: 0 },
  setStatus: ({ phase, target, message, speaker }) => set({ phase, target, error: message ?? null, speaker: speaker ?? null }),
  setUnread: (unread) => set({ unread }),
  setHolder: (holder, deviceId, muted) => set({
    holder: holder && { label: holder.label, mine: holder.deviceId === deviceId, muted: holder.muted === true },
    mutedHere: muted ? muted.includes(deviceId) : holder?.deviceId === deviceId && holder.muted === true,
  }),
}))
