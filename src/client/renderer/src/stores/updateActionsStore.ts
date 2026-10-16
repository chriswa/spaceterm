import { create } from 'zustand'
import { showToast } from '../lib/toast'

/**
 * The three ways of bringing this client and the Mac up to date — restart the
 * server, install the phone app, reload the page — and which is under way.
 *
 * One place for them: the toolbar's buttons start them, and the desktop's
 * ↻ goes through here too, so whichever starts one, every control for it
 * shows it busy and starts nothing more. What is *waiting* to be done is `usePendingUpdates`
 * (clientStalenessStore.ts); this is only what is being done.
 */
export type UpdateKind = 'restart' | 'install' | 'reload'

/**
 * Each of them takes this client away until it comes back by itself, and the
 * page is blocked meanwhile (UpdateBlocker.tsx). Control goes Away first, so
 * nothing is said to a device that has stopped listening. A no-op on the
 * server when this device does not hold it.
 */
function letGoOfControl(kind: UpdateKind): void {
  window.api.log(`[update] ${kind}: letting go of Control first`)
  window.api.receptionist.hold('release')
}

interface UpdateActionsState {
  running: Record<UpdateKind, boolean>
  /**
   * The server has taken a restart, asked for here or anywhere else (another
   * client, Control's restart_server). Blocks this page as a restart pressed
   * here does, until it reloads once the server is back (install-api.ts).
   */
  serverRestarting: boolean
  serverRestartBegun: () => void
  /** Restart the server. It reloads every client once it is back; only a failure comes back. */
  restart: () => Promise<void>
  /** Have the Mac build and install the phone app (src/server/mobile-install.ts). Success replaces this app. */
  install: () => Promise<void>
  /** Reload this page, two frames on, so the pressed state is painted before it goes. */
  reload: () => void
}

const IDLE: Record<UpdateKind, boolean> = { restart: false, install: false, reload: false }

export const useUpdateActionsStore = create<UpdateActionsState>((set, get) => {
  const mark = (kind: UpdateKind, on: boolean) => set({ running: { ...get().running, [kind]: on } })
  return {
    running: IDLE,
    serverRestarting: false,
    serverRestartBegun: () => set({ serverRestarting: true }),
    restart: async () => {
      if (get().running.restart) return
      mark('restart', true)
      letGoOfControl('restart')
      try {
        await window.api.restartSpaceterm()
      } catch (err) {
        mark('restart', false)
        showToast(`Could not restart Spaceterm: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    install: async () => {
      if (get().running.install) return
      mark('install', true)
      letGoOfControl('install')
      try {
        const outcome = await window.api.installMobileApp()
        if (outcome.ok) return
        showToast(outcome.message ?? 'The install failed.')
      } catch (err) {
        showToast(`The install failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      mark('install', false)
    },
    reload: () => {
      if (get().running.reload) return
      mark('reload', true)
      letGoOfControl('reload')
      requestAnimationFrame(() => requestAnimationFrame(() => window.location.reload()))
    }
  }
})

/**
 * What the page is blocked for, if anything. An install outranks the others:
 * it ends with the app itself replaced, and its screen says so.
 */
export function blockingUpdate(s: Pick<UpdateActionsState, 'running' | 'serverRestarting'>): UpdateKind | null {
  return s.running.install ? 'install' : restartUnderway(s) ? 'restart' : s.running.reload ? 'reload' : null
}

/** Whether a server restart is under way, whichever client or Control asked for it. */
export function restartUnderway(s: Pick<UpdateActionsState, 'running' | 'serverRestarting'>): boolean {
  return s.running.restart || s.serverRestarting
}

/** For tests: nothing under way. */
export function resetUpdateActions(): void {
  useUpdateActionsStore.setState({ running: IDLE, serverRestarting: false })
}
