import { create } from 'zustand'
import type { TerminalNodeData } from '../../../../shared/state'
import { rollingRestart, REAL_ROLLING_RESTART_DEPS, type RollingRestartDeps } from '../lib/rolling-restart'
import { showToast } from '../lib/toast'

/**
 * A rolling restart in flight, and the one way to start it.
 *
 * A store rather than component state because the control lives in the debug
 * menu, whose contents unmount when it closes: a run takes seconds per surface,
 * and its progress has to outlive the menu so the bug button can keep saying
 * it is still going — and so a second run cannot be started on top of it.
 */
export interface RollingRestartProgress {
  done: number
  total: number
}

interface RollingRestartState {
  progress: RollingRestartProgress | null
  start: (surfaces: readonly TerminalNodeData[], deps?: RollingRestartDeps) => Promise<void>
}

const plural = (n: number) => `${n} agent surface${n === 1 ? '' : 's'}`

export const useRollingRestartStore = create<RollingRestartState>((set, get) => ({
  progress: null,
  start: async (surfaces, deps = REAL_ROLLING_RESTART_DEPS) => {
    if (surfaces.length === 0 || get().progress !== null) return
    set({ progress: { done: 0, total: surfaces.length } })
    showToast(`Restarting ${plural(surfaces.length)}…`)
    const { restarted, failed } = await rollingRestart(surfaces, (done, total) => set({ progress: { done, total } }), deps)
    set({ progress: null })
    showToast(failed === 0
      ? `Restarted ${plural(restarted)}`
      : `Restarted ${restarted}, ${failed} failed — see their alerts`)
  }
}))
