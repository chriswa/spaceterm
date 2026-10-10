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

interface UpdateActionsState {
  running: Record<UpdateKind, boolean>
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
    restart: async () => {
      if (get().running.restart) return
      mark('restart', true)
      showToast('Restarting server…')
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
      showToast('Installing the app…')
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
      requestAnimationFrame(() => requestAnimationFrame(() => window.location.reload()))
    }
  }
})

/** For tests: nothing under way. */
export function resetUpdateActions(): void {
  useUpdateActionsStore.setState({ running: IDLE })
}
