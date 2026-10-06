import { pendingUpdates, usePendingUpdates, useClientStalenessStore, type PendingUpdates } from '@/stores/clientStalenessStore'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import type { UpdateKind } from '@/stores/updateActionsStore'

/**
 * The notifications for bringing the phone and the Mac up to date: a server
 * restart an agent flagged, a newer app, a newer page. Each is a row in the
 * bell's list with a button that does it (updateActionsStore.ts), and counts
 * toward the bell like an approval request.
 */

export interface UpdateNotice {
  kind: UpdateKind
  title: string
  subtitle: string
  action: string
  busy: string
}

const ORDER: readonly UpdateKind[] = ['restart', 'install', 'reload']

/** The key an update notice is marked read by, beside the approvals' keys. */
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
