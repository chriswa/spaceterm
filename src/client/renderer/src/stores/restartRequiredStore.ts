import { create } from 'zustand'

/**
 * Whether a server restart has been flagged as needed, and why.
 *
 * Fed by `server-sync.ts`: a PULL on every renderer (re)load hydrates it from
 * the server (the authoritative channel), and a PUSH keeps it live while an
 * agent raises or clears the flag mid-session. The Restart button reads it to
 * animate when a restart is pending. See `src/server/restart-flag.ts`.
 */
interface RestartRequiredState {
  required: boolean
  /** Human-readable why, shown in the button tooltip. Empty when not required. */
  reason: string
  set: (required: boolean, reason: string) => void
}

export const useRestartRequiredStore = create<RestartRequiredState>((set) => ({
  required: false,
  reason: '',
  set: (required, reason) => set({ required, reason })
}))
