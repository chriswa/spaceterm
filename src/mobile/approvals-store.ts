import { useEffect } from 'react'
import { create } from 'zustand'
import { approvalKey, parseApprovalDocument, type ApprovalItem, type ApprovalsSnapshot, type ApprovalTone } from '../shared/approvals'

/**
 * The phone's notifications: approval requests waiting on the Mac (opProxy's,
 * for now), which ones it has looked at, and which one is open.
 *
 * "Unread" is per phone and only for this page's life (plus a reload): a
 * request is read once the list has shown it. The bell pulses while anything
 * is unread, and stays lit while anything is pending.
 */

const SEEN_KEY = 'spaceterm.approvals.seen'

interface ApprovalsState {
  snapshot: ApprovalsSnapshot
  seen: ReadonlySet<string>
  listOpen: boolean
  /** `approvalKey` of the request on screen. Kept after it closes, to say why it went. */
  openKey: string | null
  setSnapshot(snapshot: ApprovalsSnapshot): void
  setListOpen(open: boolean): void
  openItem(key: string): void
  closeItem(): void
  /** The open request was answered from this phone: close it, back to the list if more are waiting. */
  answered(key: string): void
}

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function saveSeen(seen: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]))
  } catch {
    // Private browsing or storage off: unread just resets on reload.
  }
}

/** Everything pending is read now, and what is no longer pending is forgotten. */
function markRead(items: readonly ApprovalItem[]): Set<string> {
  const seen = new Set(items.map(approvalKey))
  saveSeen(seen)
  return seen
}

export const EMPTY_APPROVALS: ApprovalsSnapshot = { sources: [], items: [], closed: [] }

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  snapshot: EMPTY_APPROVALS,
  seen: loadSeen(),
  listOpen: false,
  openKey: null,
  setSnapshot: (snapshot) => {
    // Anything arriving while the list is up has been seen.
    const { listOpen, seen } = get()
    set({ snapshot, seen: listOpen ? markRead(snapshot.items) : seen })
  },
  setListOpen: (listOpen) => set(listOpen ? { listOpen, seen: markRead(get().snapshot.items) } : { listOpen }),
  openItem: (openKey) => set({ openKey, listOpen: false }),
  closeItem: () => set({ openKey: null }),
  answered: (key) => {
    if (get().openKey !== key) return
    const others = get().snapshot.items.some((item) => approvalKey(item) !== key)
    set({ openKey: null })
    if (others) get().setListOpen(true)
  },
}))

export function unreadCount(snapshot: ApprovalsSnapshot, seen: ReadonlySet<string>): number {
  return snapshot.items.filter((item) => !seen.has(approvalKey(item))).length
}

const TONE_RANK: Record<string, number> = { info: 0, caution: 1, danger: 2 }

/** The most urgent tone among the pending requests, which the bell takes; null with none pending. */
export function loudestTone(items: readonly ApprovalItem[]): ApprovalTone | null {
  let loudest: ApprovalTone | null = null
  for (const item of items) {
    const tone = toneOf(parseApprovalDocument(item.document)?.tone)
    if (loudest === null || TONE_RANK[tone] > TONE_RANK[loudest]) loudest = tone
  }
  return loudest
}

/** A tone this client knows; an unknown one is taken as caution. */
export function toneOf(tone: string | undefined): ApprovalTone {
  return tone === 'info' || tone === 'danger' ? tone : 'caution'
}

/** Keeps the store fed from the server for as long as the phone app is up. */
export function useApprovalsWatch(): void {
  useEffect(() => window.api.node.watchApprovals((snapshot) => useApprovalsStore.getState().setSnapshot(snapshot)), [])
}
