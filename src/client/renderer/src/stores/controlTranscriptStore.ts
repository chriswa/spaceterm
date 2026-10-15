import { create } from 'zustand'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'

const ACTIVITY_KEY = 'controlTranscript.activity'
const DRAFT_KEY = 'controlTranscript.draft'
/** What the box was called before it was Activity, so a device that had it ticked still does. */
const OLD_KEY = 'controlTranscript.reasoning'

function readActivity(): boolean {
  try { return (localStorage.getItem(ACTIVITY_KEY) ?? localStorage.getItem(OLD_KEY)) === 'true' } catch { return false }
}

function readDraft(): string {
  try { return localStorage.getItem(DRAFT_KEY) ?? '' } catch { return '' }
}

interface ControlTranscriptState {
  open: boolean
  /**
   * Messages sent to Control while the transcript is open — typed, or spoken
   * into the phone's talk button — that its record does not have yet, shown
   * at the bottom until it does.
   */
  pending: string[]
  /**
   * Whether the transcript shows Control's activity: news arriving, the
   * backlog, watches, replies never spoken. Remembered on this device.
   */
  activity: boolean
  /**
   * What is typed in the box and not yet sent. Kept here, not in the view, so
   * it outlives closing the transcript; remembered on this device, so it
   * outlives a reload too.
   */
  draft: string
  setOpen: (open: boolean) => void
  setActivity: (activity: boolean) => void
  setDraft: (draft: string) => void
  /** A message just sent to Control. Ignored while the transcript is closed. */
  addPending: (text: string) => void
  /** Entries the record gained: the messages among them are no longer pending. */
  settle: (added: readonly ControlTranscriptEntry[]) => void
}

/**
 * Control's transcript view: whether it is open, and what is on its way into
 * it. Its own store because what opens it — the Control button, on the Mac
 * and the phone — is a standalone widget that cannot reach the host that draws it
 * (`App` on the desktop, `MobileApp` on the phone), and because the phone's
 * talk button sends into it from outside it.
 */
export const useControlTranscriptStore = create<ControlTranscriptState>((set) => ({
  open: false,
  pending: [],
  activity: readActivity(),
  draft: readDraft(),
  setOpen: (open) => set(open ? { open } : { open, pending: [] }),
  setActivity: (activity) => {
    try { localStorage.setItem(ACTIVITY_KEY, String(activity)) } catch { /* a private window: this visit only */ }
    set({ activity })
  },
  setDraft: (draft) => {
    try {
      if (draft) localStorage.setItem(DRAFT_KEY, draft)
      else localStorage.removeItem(DRAFT_KEY)
    } catch { /* a private window: this visit only */ }
    set({ draft })
  },
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
