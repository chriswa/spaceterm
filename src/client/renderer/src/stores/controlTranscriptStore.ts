import { create } from 'zustand'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'

interface ControlTranscriptState {
  open: boolean
  /**
   * Messages sent to Control while the transcript is open — typed, or spoken
   * into the phone's talk button — that its record does not have yet, shown
   * at the bottom until it does.
   */
  pending: string[]
  setOpen: (open: boolean) => void
  /** A message just sent to Control. Ignored while the transcript is closed. */
  addPending: (text: string) => void
  /** Entries the record gained: the messages among them are no longer pending. */
  settle: (added: readonly ControlTranscriptEntry[]) => void
}

/**
 * Control's transcript view: whether it is open, and what is on its way into
 * it. Its own store because what opens it — a long press on either Control
 * button — is a standalone widget that cannot reach the host that draws it
 * (`App` on the desktop, `MobileApp` on the phone), and because the phone's
 * talk button sends into it from outside it.
 */
export const useControlTranscriptStore = create<ControlTranscriptState>((set) => ({
  open: false,
  pending: [],
  setOpen: (open) => set(open ? { open } : { open, pending: [] }),
  addPending: (text) => set((s) => (s.open ? { pending: [...s.pending, text] } : s)),
  settle: (added) => set((s) => ({ pending: settlePending(s.pending, added) })),
}))

/** Pending messages, less those the record now has. */
export function settlePending(pending: readonly string[], added: readonly ControlTranscriptEntry[]): string[] {
  const left = [...pending]
  for (const entry of added) {
    if (entry.kind !== 'user') continue
    const at = left.indexOf(entry.text)
    if (at >= 0) left.splice(at, 1)
  }
  return left
}
