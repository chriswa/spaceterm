import { create } from 'zustand'

interface HoveredCardStoreState {
  hoveredNodeId: string | null
  setHoveredNode(nodeId: string | null): void
  toolbarHoveredNodeId: string | null
  setToolbarHoveredNode(nodeId: string | null): void
}

export const useHoveredCardStore = create<HoveredCardStoreState>((set) => ({
  hoveredNodeId: null,
  setHoveredNode: (nodeId) => set({ hoveredNodeId: nodeId }),
  toolbarHoveredNodeId: null,
  setToolbarHoveredNode: (nodeId) => set({ toolbarHoveredNodeId: nodeId }),
}))
