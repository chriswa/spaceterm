import { create } from 'zustand'

interface ScriptsSocketPathState {
  /** Mirror of `ServerState.scriptsSocketPath`; undefined until the first sync. */
  path: string | undefined
  set: (path: string | undefined) => void
}

/** Where the server listens for scripts, for the automation card's event line. */
export const useScriptsSocketPathStore = create<ScriptsSocketPathState>((set) => ({
  path: undefined,
  set: (path) => set({ path }),
}))
