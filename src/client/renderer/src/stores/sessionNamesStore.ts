import { create } from 'zustand'

/**
 * Maps a Claude session id to an assigned call-sign (the name spoken as
 * "⟨name⟩ here."), sent wholesale by the external Voice Operator daemon and
 * forwarded by the server. Keyed by `claudeSessionId` (NOT surfaceId/nodeId) —
 * the renderer resolves a session id to a surface at render time against each
 * node's `claudeSessionHistory`, mirroring how the speaking store is consumed.
 *
 * Authoritative + idempotent: every update REPLACES the map wholesale, never
 * merges. A name disappearing from the map (session released/reaped) therefore
 * clears that name from every surface automatically. An empty map is valid and
 * means "no named sessions".
 */

interface SessionNamesState {
  /** claudeSessionId -> assigned display name. */
  names: Record<string, string>
  /** Replace the entire map (never merge). */
  setNames: (names: Record<string, string>) => void
}

export const useSessionNamesStore = create<SessionNamesState>((set) => ({
  names: {},
  setNames: (names) => set({ names }),
}))
