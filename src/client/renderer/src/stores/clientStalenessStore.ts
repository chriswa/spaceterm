import { create } from 'zustand'
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

/** Each thing waiting to bring this client and the Mac up to date. */
export interface PendingUpdates {
  restart: boolean
  install: boolean
  reload: boolean
}

/**
 * What to ask for, given what is behind. A reload is not asked for while a
 * server restart is — the restarted server reloads every client anyway — nor
 * while the app is behind, since the new app loads the new page.
 */
export function pendingUpdates(state: { restart: boolean; native: boolean; web: boolean }): PendingUpdates {
  return {
    restart: state.restart,
    install: state.native,
    reload: state.web && !state.restart && !state.native
  }
}

export function anyPending(pending: PendingUpdates): boolean {
  return pending.restart || pending.install || pending.reload
}

/** `pendingUpdates` over the live stores: the server's restart flag and this client's staleness. */
export function usePendingUpdates(): PendingUpdates {
  const restart = useRestartRequiredStore((s) => s.required)
  const web = useClientStalenessStore((s) => s.web)
  const native = useClientStalenessStore((s) => s.native)
  return pendingUpdates({ restart, web, native })
}
