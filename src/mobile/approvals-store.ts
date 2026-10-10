import { useEffect } from 'react'
import { create } from 'zustand'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { approvalKey, parseApprovalDocument, type ApprovalItem, type ApprovalsSnapshot, type ApprovalTone } from '../shared/approvals'
import { pendingUpdateKeys } from './update-notices'
import { lostStatusKeys } from './provider-status'
import { playCue } from './cues'

/**
 * The phone's notifications: approval requests waiting on the Mac (opProxy's,
 * for now), a source's status gone bad (provider-status.ts: opProxy's
 * 1Password authorization lost), and updates waiting to be done
 * (update-notices.ts); which ones it has looked at, and which request is open.
 *
 * "Unread" is per phone and only for this page's life (plus a reload): a
 * notice is read once the toolbar sheet has shown it — requests in its
 * Notifications section, updates as the strip's marching buttons. The rocket
 * pulses while anything is unread, and carries a count while anything is
 * pending.
 */

const SEEN_KEY = 'spaceterm.approvals.seen'

interface ApprovalsState {
  snapshot: ApprovalsSnapshot
  seen: ReadonlySet<string>
  /** `approvalKey` of the request on screen. Kept after it closes, to say why it went. */
  openKey: string | null
  setSnapshot(snapshot: ApprovalsSnapshot): void
  /** Everything pending now has been shown. */
  markAllRead(): void
  /** Open a request, in place of the toolbar sheet it was picked from. */
  openItem(key: string): void
  closeItem(): void
  /** The open request was answered from this phone: close it, back to the sheet if more are waiting. */
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
function markRead(snapshot: ApprovalsSnapshot): Set<string> {
  const seen = new Set([...snapshot.items.map(approvalKey), ...lostStatusKeys(snapshot), ...pendingUpdateKeys()])
  saveSeen(seen)
  return seen
}

export const EMPTY_APPROVALS: ApprovalsSnapshot = { sources: [], items: [], closed: [] }

export const useApprovalsStore = create<ApprovalsState>((set, get) => ({
  snapshot: EMPTY_APPROVALS,
  seen: loadSeen(),
  openKey: null,
  setSnapshot: (snapshot) => {
    // Anything arriving while the sheet is up has been seen.
    const sheetOpen = useSurfacePresenterStore.getState().toolbarSheetOpen
    set({ snapshot, seen: sheetOpen ? markRead(snapshot) : get().seen })
  },
  markAllRead: () => set({ seen: markRead(get().snapshot) }),
  openItem: (openKey) => {
    set({ openKey })
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
  },
  closeItem: () => set({ openKey: null }),
  answered: (key) => {
    if (get().openKey !== key) return
    const others = get().snapshot.items.some((item) => approvalKey(item) !== key)
    set({ openKey: null })
    if (others) useSurfacePresenterStore.getState().setToolbarSheetOpen(true)
  },
}))

/** Every notice waiting: requests and lost statuses from `snapshot`, plus `updateKeys` (update-notices.ts). */
export function pendingKeys(snapshot: ApprovalsSnapshot, updateKeys: readonly string[]): string[] {
  return [...snapshot.items.map(approvalKey), ...lostStatusKeys(snapshot), ...updateKeys]
}

export function unreadCount(snapshot: ApprovalsSnapshot, updateKeys: readonly string[], seen: ReadonlySet<string>): number {
  return pendingKeys(snapshot, updateKeys).filter((key) => !seen.has(key)).length
}

const TONE_RANK: Record<string, number> = { info: 0, caution: 1, danger: 2 }

/** The most urgent tone among the pending requests, which the rocket's count takes; null with none pending. */
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

/**
 * The keys of requests in `snapshot` not yet announced, adding them to
 * `announced`. A request is announced once, however often it is re-sent.
 */
export function takeArrivals(snapshot: ApprovalsSnapshot, announced: Set<string>): string[] {
  const arrivals = snapshot.items.map(approvalKey).filter((key) => !announced.has(key))
  for (const key of arrivals) announced.add(key)
  return arrivals
}

/**
 * Keeps the store fed from the server for as long as the phone app is up, and
 * chimes when a request arrives — opProxy's own question chime. Requests
 * already read before a reload stay quiet.
 */
export function useApprovalsWatch(): void {
  useEffect(() => {
    const announced = new Set(useApprovalsStore.getState().seen)
    return window.api.node.watchApprovals((snapshot) => {
      useApprovalsStore.getState().setSnapshot(snapshot)
      if (takeArrivals(snapshot, announced).length > 0) playCue('approvalRequested')
    })
  }, [])
}
