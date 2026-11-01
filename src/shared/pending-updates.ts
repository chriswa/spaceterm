/**
 * Each thing waiting to bring one client and the Mac up to date, from what is
 * behind: the server's restart flag, and the client's own page (`web`) and the
 * native app around it (`native`), as the phone's update-check.ts finds them.
 *
 * One rule for both readers: the rocket menu's sparks and buttons
 * (clientStalenessStore.ts), and what Control is told is pending
 * (src/server/receptionist/spaceterm-status.ts), so the two never disagree.
 */
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
