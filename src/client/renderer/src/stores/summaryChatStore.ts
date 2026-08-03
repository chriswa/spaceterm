import { create } from 'zustand'
import type { NodeId } from '../../../../shared/ids'
import type { SummaryChatPhase, SummaryChatUiState } from '../../../../shared/api'

interface SummaryChatState {
  /** The surface that receives unqualified Voice Operator follow-up commands. */
  targetNodeId: NodeId | null
  /**
   * nodeId -> what that surface is doing. An absent key means `ready`.
   *
   * One value rather than two booleans: the server emits `thinking`,
   * `speaking` and `ready` from a single transition, so consumers read the
   * phase instead of deciding which of several overlapping flags wins.
   */
  phase: Record<string, Exclude<SummaryChatPhase, 'ready'>>
  setStatus: (nodeId: NodeId, state: SummaryChatUiState) => void
}

export const useSummaryChatStore = create<SummaryChatState>((set) => ({
  targetNodeId: null,
  phase: {},
  setStatus: (nodeId, state) => {
    // `target` says which surface voice follow-ups address; it does not change
    // what that surface is doing. `error` always ends a phase.
    if (state === 'target') {
      set({ targetNodeId: nodeId })
      return
    }
    set((current) => {
      if (state === 'ready' || state === 'error') {
        if (!(nodeId in current.phase)) return current
        const phase = { ...current.phase }
        delete phase[nodeId]
        return { phase }
      }
      if (current.phase[nodeId] === state) return current
      return { phase: { ...current.phase, [nodeId]: state } }
    })
  },
}))
