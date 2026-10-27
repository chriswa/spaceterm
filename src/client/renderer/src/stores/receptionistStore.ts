import { create } from 'zustand'
import type { ReceptionistPhase, ReceptionistStatus } from '../../../../shared/api'
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

export interface ReceptionistState {
  /** What the receptionist is doing. Server-owned, the same on every client. */
  phase: ReceptionistPhase
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
  /** How many items are on Control's backlog. */
  backlog: number
  /** Control's backlog is held: nothing on it comes up on its own (Hold backlog). */
  backlogHeld: boolean
  setStatus: (status: ReceptionistStatus) => void
  setUnread: (unread: { count: number; first?: number }) => void
  setBacklog: (backlog: { count: number; held: boolean }) => void
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
  error: null,
  holder: null,
  mutedHere: false,
  speaker: null,
  unread: { count: 0 },
  backlog: 0,
  backlogHeld: false,
  setStatus: ({ phase, message, speaker }) => set({ phase, error: message ?? null, speaker: speaker ?? null }),
  setUnread: (unread) => set({ unread }),
  setBacklog: ({ count, held }) => set({ backlog: count, backlogHeld: held }),
  setHolder: (holder, deviceId, muted) => set({
    holder: holder && { label: holder.label, mine: holder.deviceId === deviceId, muted: holder.muted === true },
    mutedHere: muted ? muted.includes(deviceId) : holder?.deviceId === deviceId && holder.muted === true,
  }),
}))

/**
 * Where Control is, as far as this device goes — the one thing the user sees
 * and chooses: not here, here in writing (held, muted), or here aloud (held,
 * unmuted). The server keeps holding and muting apart and remembers this
 * device's mute while it does not hold Control, but that mute changes nothing
 * the user can see until Control is here, so Released hides it.
 */
export type ControlMode = 'released' | 'text' | 'speak'

export function controlMode({ holder, mutedHere }: Pick<ReceptionistState, 'holder' | 'mutedHere'>): ControlMode {
  if (!holder?.mine) return 'released'
  return mutedHere ? 'text' : 'speak'
}

/**
 * Control is thinking where it can be heard: this device holds it, unmuted.
 * The thinking cue's condition — the echo is a prelude to speech, so it plays
 * only where the speech will, and never on a device that is merely watching.
 */
export function isThinkingWithinEarshot(state: Pick<ReceptionistState, 'phase' | 'holder'>, alsoSynthesizing = false): boolean {
  const waiting = state.phase === 'thinking' || (alsoSynthesizing && state.phase === 'synthesizing')
  return waiting && state.holder?.mine === true && !state.holder.muted
}
