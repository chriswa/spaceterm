import { create } from 'zustand'
import { type NodeId } from '../../../../shared/ids'

interface ReparentStoreState {
  reparentingNodeId: NodeId | null
  hoveredNodeId: NodeId | null
  startReparent(nodeId: NodeId): void
  setHoveredNode(nodeId: NodeId | null): void
  reset(): void
}

export const useReparentStore = create<ReparentStoreState>((set) => ({
  reparentingNodeId: null,
  hoveredNodeId: null,
  startReparent: (nodeId) => set({ reparentingNodeId: nodeId, hoveredNodeId: null }),
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  reset: () => set({ reparentingNodeId: null, hoveredNodeId: null }),
}))
