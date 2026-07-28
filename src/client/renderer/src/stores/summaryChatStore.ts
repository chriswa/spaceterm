import { create } from 'zustand'

interface SummaryChatState {
  /** The surface that receives unqualified Voice Operator follow-up commands. */
  targetNodeId: string | null
  /** Nodes currently waiting for Haiku. */
  thinking: Record<string, true>
  setStatus: (nodeId: string, state: 'thinking' | 'ready' | 'target' | 'error') => void
}

export const useSummaryChatStore = create<SummaryChatState>((set) => ({
  targetNodeId: null,
  thinking: {},
  setStatus: (nodeId, state) => {
    if (state === 'target') {
      set({ targetNodeId: nodeId })
      return
    }
    if (state === 'thinking') {
      set((current) => ({ thinking: { ...current.thinking, [nodeId]: true } }))
      return
    }
    set((current) => {
      if (!(nodeId in current.thinking)) return current
      const thinking = { ...current.thinking }
      delete thinking[nodeId]
      return { thinking }
    })
  },
}))
