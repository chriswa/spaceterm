import { create } from 'zustand'
import { type NodeId } from '../../../../shared/ids'

interface HoveredCardStoreState {
  hoveredNodeId: NodeId | null
  setHoveredNode(nodeId: NodeId | null): void
  toolbarHoveredNodeId: NodeId | null
  setToolbarHoveredNode(nodeId: NodeId | null): void
}

export const useHoveredCardStore = create<HoveredCardStoreState>((set) => ({
  hoveredNodeId: null,
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  toolbarHoveredNodeId: null,
  setToolbarHoveredNode: (nodeId) => set({ toolbarHoveredNodeId: nodeId }),
}))
