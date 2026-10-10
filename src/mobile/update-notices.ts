import { create } from 'zustand'
import { pendingUpdates, usePendingUpdates, useClientStalenessStore, type PendingUpdates } from '@/stores/clientStalenessStore'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import type { UpdateKind } from '@/stores/updateActionsStore'

/**
 * The phone's notifications, which are all about bringing the phone and the
 * Mac up to date: a server restart an agent flagged, a newer app, a newer
 * page. Each counts on the rocket; the sheet it opens does them with the
 * strip's own buttons, which march their ants while one waits.
 *
 * "Unread" is per phone and only for this page's life (plus a reload): a
 * notice is read once the toolbar sheet has shown it. The rocket pulses while
 * anything is unread.
 */

export interface UpdateNotice {
  kind: UpdateKind
  title: string
  subtitle: string
  action: string
  busy: string
}

const ORDER: readonly UpdateKind[] = ['restart', 'install', 'reload']

/** The key an update notice is marked read by. */
export const updateNoticeKey = (kind: UpdateKind) => `update:${kind}`

export function updateKinds(pending: PendingUpdates): UpdateKind[] {
  return ORDER.filter((kind) => pending[kind])
}

export function updateNotice(kind: UpdateKind, restartReason: string): UpdateNotice {
  switch (kind) {
    case 'restart':
      return { kind, title: 'Server restart needed', subtitle: restartReason || 'Flagged by an agent', action: 'Restart', busy: 'Restarting…' }
    case 'install':
      return { kind, title: 'A newer app is ready', subtitle: 'The Mac builds and installs it', action: 'Install', busy: 'Installing…' }
    case 'reload':
      return { kind, title: 'A newer page is ready', subtitle: 'Reload to pick it up', action: 'Reload', busy: 'Reloading…' }
  }
}

/** The update notices waiting now, live. */
export function useUpdateNotices(): UpdateNotice[] {
  const pending = usePendingUpdates()
  const reason = useRestartRequiredStore((s) => s.reason)
  return updateKinds(pending).map((kind) => updateNotice(kind, reason))
}

/** The keys of the update notices waiting now, outside React. */
export function pendingUpdateKeys(): string[] {
  const { web, native } = useClientStalenessStore.getState()
  const restart = useRestartRequiredStore.getState().required
  return updateKinds(pendingUpdates({ restart, web, native })).map(updateNoticeKey)
}

const SEEN_KEY = 'spaceterm.notices.seen'

function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

interface NoticesReadState {
  seen: ReadonlySet<string>
  /** Everything pending now has been shown; what is no longer pending is forgotten. */
  markAllRead(): void
}

export const useNoticesRead = create<NoticesReadState>((set) => ({
  seen: loadSeen(),
  markAllRead: () => {
    const seen = new Set(pendingUpdateKeys())
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]))
    } catch {
      // Private browsing or storage off: unread just resets on reload.
    }
    set({ seen })
  },
}))
