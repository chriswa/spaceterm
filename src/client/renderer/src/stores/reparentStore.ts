import { create } from 'zustand'

interface ReparentStoreState {
  reparentingNodeId: string | null
  hoveredNodeId: string | null
  startReparent(nodeId: string): void
  setHoveredNode(nodeId: string | null): void
  reset(): void
}

export const useReparentStore = create<ReparentStoreState>((set) => ({
  reparentingNodeId: null,
  hoveredNodeId: null,
  startReparent: (nodeId) => set({ reparentingNodeId: nodeId, hoveredNodeId: null }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  reset: () => set({ reparentingNodeId: null, hoveredNodeId: null }),
}))
