import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'

/**
 * Tracks which terminal nodes are currently speaking through Summary Chat.
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
  /** nodeId -> speaking metadata. Presence of the key means "speaking". */
  speaking: Record<string, SpeakingEntry>
  setSpeaking: (nodeId: NodeId, speaking: boolean, voice?: string) => void
}

/** Per-session safety timers, kept outside zustand state (not render-relevant). */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTimer(nodeId: NodeId): void {
  const t = timers.get(nodeId)
  if (t) {
    clearTimeout(t)
    timers.delete(nodeId)
  }
}

export const useSpeakingStore = create<SpeakingState>((set) => ({
  speaking: {},
  setSpeaking: (nodeId, speaking, voice) => {
    clearTimer(nodeId)
    if (speaking) {
      timers.set(nodeId, setTimeout(() => {
        timers.delete(nodeId)
        set((state) => {
          if (!(nodeId in state.speaking)) return state
          const next = { ...state.speaking }
          delete next[nodeId]
          return { speaking: next }
        })
      }, MAX_SPEAK_MS))
      set((state) => ({ speaking: { ...state.speaking, [nodeId]: { voice } } }))
    } else {
      set((state) => {
        if (!(nodeId in state.speaking)) return state
        const next = { ...state.speaking }
        delete next[nodeId]
        return { speaking: next }
      })
    }
  },
}))
