import { create } from 'zustand'

/**
 * Tracks which Claude sessions are currently "speaking" via the external TTS
 * daemon. Keyed by `claudeSessionId` (NOT surfaceId/nodeId) — the daemon and the
 * server both speak in terms of Claude session ids, and the renderer resolves
 * a session id to a crab at render time against each node's `claudeSessionHistory`.
 *
 * Modeled as a map rather than a single id because in `--all` mode any number of
 * Claude sessions can speak concurrently.
 *
 * Robustness: the daemon sends a `speaking: false` when speech ends, but we never
 * assume it arrives — a stuck "speaking" flag is auto-cleared after MAX_SPEAK_MS,
 * and a fresh `speaking: true` for a session resets that session's timer.
 */

/** Auto-clear a session's speaking flag after this long with no `stop`. */
const MAX_SPEAK_MS = 300_000

interface SpeakingEntry {
  voice?: string
}

interface SpeakingState {
  /** claudeSessionId -> speaking metadata. Presence of the key means "speaking". */
  speaking: Record<string, SpeakingEntry>
  setSpeaking: (claudeSessionId: string, speaking: boolean, voice?: string) => void
}

/** Per-session safety timers, kept outside zustand state (not render-relevant). */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(claudeSessionId: string): void {
  const t = timers.get(claudeSessionId)
  if (t) {
    clearTimeout(t)
    timers.delete(claudeSessionId)
  }
}

export const useSpeakingStore = create<SpeakingState>((set) => ({
  speaking: {},
  setSpeaking: (claudeSessionId, speaking, voice) => {
    clearTimer(claudeSessionId)
    if (speaking) {
      timers.set(claudeSessionId, setTimeout(() => {
        timers.delete(claudeSessionId)
        set((state) => {
          if (!(claudeSessionId in state.speaking)) return state
          const next = { ...state.speaking }
          delete next[claudeSessionId]
          return { speaking: next }
        })
      }, MAX_SPEAK_MS))
      set((state) => ({ speaking: { ...state.speaking, [claudeSessionId]: { voice } } }))
    } else {
      set((state) => {
        if (!(claudeSessionId in state.speaking)) return state
        const next = { ...state.speaking }
        delete next[claudeSessionId]
        return { speaking: next }
      })
    }
  },
}))
