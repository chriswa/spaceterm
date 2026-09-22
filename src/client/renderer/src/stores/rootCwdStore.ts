import { create } from 'zustand'

interface RootCwdState {
  /**
   * The working directory the root node supplies, or undefined for none.
   * Mirror of `ServerState.rootCwd`, stored abbreviated (`~/research`).
   */
  cwd: string | undefined
  set: (cwd: string | undefined) => void
}

/**
 * Where a card created at the top level starts.
 *
 * A store of its own rather than a field on the node store: the root is not a
 * node, and `nodeStore.applyServerState` replaces the node map wholesale on
 * every resync, which would drop anything parked in it that is not a node.
 */
export const useRootCwdStore = create<RootCwdState>((set) => ({
  cwd: undefined,
  set: (cwd) => set({ cwd }),
}))
