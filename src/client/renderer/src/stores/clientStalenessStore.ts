import { create } from 'zustand'
import { pendingUpdates, type PendingUpdates } from '../../../../shared/pending-updates'
import { useRestartRequiredStore } from './restartRequiredStore'

/**
 * Whether this client is running older code than the Mac has: the page (`web`,
 * a reload fixes it) or the native app around it (`native`, only an install
 * does). The phone's `update-check.ts` feeds it; on the desktop nothing does,
 * and both stay false.
 */
interface ClientStalenessState {
  web: boolean
  native: boolean
  set: (next: { web: boolean; native: boolean }) => void
}

export const useClientStalenessStore = create<ClientStalenessState>((set) => ({
  web: false,
  native: false,
  set: ({ web, native }) => set({ web, native })
}))

export { anyPending, pendingUpdates, type PendingUpdates } from '../../../../shared/pending-updates'

/** `pendingUpdates` over the live stores: the server's restart flag and this client's staleness. */
export function usePendingUpdates(): PendingUpdates {
  const restart = useRestartRequiredStore((s) => s.required)
  const web = useClientStalenessStore((s) => s.web)
  const native = useClientStalenessStore((s) => s.native)
  return pendingUpdates({ restart, web, native })
}
