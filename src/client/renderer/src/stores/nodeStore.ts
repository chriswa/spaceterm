import { create } from 'zustand'
import type { ServerState, NodeData, TerminalNodeData, MarkdownNodeData, DirectoryNodeData, ArchivedNode } from '../../../../shared/state'
import { nodePixelSize } from '../../../../shared/node-size'

export { nodePixelSize }

// --- Store types ---

interface NodeStoreState {
  // Server ground truth
  serverNodes: Record<string, NodeData>
  nextZIndex: number
  initialSyncDone: boolean
  rootArchivedChildren: ArchivedNode[]

  // Local overrides that temporarily win over server values
  localOverrides: Record<string, { fields: Partial<NodeData>; suppressFields: Set<string>; createdAt: number }>

  // Merged view (what components read)
  nodes: Record<string, NodeData>

  // Derived arrays
  liveTerminals: TerminalNodeData[]
  markdowns: MarkdownNodeData[]
  directories: DirectoryNodeData[]

  // All node IDs in array form for iteration
  nodeList: NodeData[]

  // --- Local mutations (optimistic, instant) ---
  moveNode(id: string, x: number, y: number): void
  batchMoveNodes(moves: Array<{ id: string; dx: number; dy: number }>): void
  renameNode(id: string, name: string): void
  setNodeColor(id: string, colorPresetId: string): void
  setNodeFood(id: string, food: boolean): void
  bringToFront(id: string): void

  // --- Server sync handlers ---
  applyServerState(state: ServerState): void
  applyServerNodeUpdate(id: string, fields: Partial<NodeData>): void
  applyServerNodeAdd(node: NodeData): void
  applyServerNodeRemove(id: string): void

  // --- Override management ---
  setOverride(id: string, fields: Partial<NodeData>, suppressFields: string[]): void
  clearOverride(id: string, fields?: string[]): void
}

function recomputeDerived(nodes: Record<string, NodeData>) {
  const nodeList = Object.values(nodes)
  const liveTerminals: TerminalNodeData[] = []
  const markdowns: MarkdownNodeData[] = []
  const directories: DirectoryNodeData[] = []

  for (const node of nodeList) {
    if (node.type === 'terminal') {
      liveTerminals.push(node)
    } else if (node.type === 'directory') {
      directories.push(node)
    } else {
      markdowns.push(node)
    }
  }

  return { nodeList, liveTerminals, markdowns, directories }
}

function mergeNodes(
  serverNodes: Record<string, NodeData>,
  localOverrides: Record<string, { fields: Partial<NodeData>; suppressFields: Set<string>; createdAt: number }>
): Record<string, NodeData> {
  const result: Record<string, NodeData> = {}

  for (const [id, serverNode] of Object.entries(serverNodes)) {
    const override = localOverrides[id]
    if (override) {
      result[id] = { ...serverNode, ...override.fields } as NodeData
    } else {
      result[id] = serverNode
    }
  }

  return result
}

export const useNodeStore = create<NodeStoreState>((set, get) => ({
  serverNodes: {},
  nextZIndex: 1,
  initialSyncDone: false,
  rootArchivedChildren: [],
  localOverrides: {},
  nodes: {},
  liveTerminals: [],
  markdowns: [],
  directories: [],
  nodeList: [],

  // --- Local mutations ---

  moveNode(id, x, y) {
    set(state => {
      const node = state.nodes[id]
      if (!node) return state
      const fields = { x, y } as Partial<NodeData>
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), 'x', 'y']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  batchMoveNodes(moves) {
    if (moves.length === 0) return
    set(state => {
      const moveMap = new Map(moves.map(m => [m.id, m]))
      const newOverrides = { ...state.localOverrides }
      for (const [id, m] of moveMap) {
        const node = state.nodes[id]
        if (!node) continue
        const newX = node.x + m.dx
        const newY = node.y + m.dy
        newOverrides[id] = {
          fields: { ...newOverrides[id]?.fields, x: newX, y: newY },
          suppressFields: new Set([...(newOverrides[id]?.suppressFields ?? []), 'x', 'y']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  renameNode(id, name) {
    set(state => {
      const node = state.nodes[id]
      if (!node) return state
      const fields = { name: name || undefined } as Partial<NodeData>
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), 'name']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  setNodeColor(id, colorPresetId) {
    set(state => {
      const node = state.nodes[id]
      if (!node) return state
      const fields = { colorPresetId } as Partial<NodeData>
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), 'colorPresetId']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  setNodeFood(id, food) {
    set(state => {
      const node = state.nodes[id]
      if (!node) return state
      const fields = { food: food || undefined } as Partial<NodeData>
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), 'food']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  bringToFront(id) {
    set(state => {
      const node = state.nodes[id]
      if (!node) return state
      const z = state.nextZIndex + 1
      const fields = { zIndex: z } as Partial<NodeData>
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), 'zIndex']),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { nextZIndex: z, localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  // --- Server sync handlers ---

  applyServerState(serverState) {
    set(() => {
      const serverNodes = serverState.nodes
      const merged = mergeNodes(serverNodes, {})
      return {
        serverNodes,
        nextZIndex: serverState.nextZIndex,
        initialSyncDone: true,
        rootArchivedChildren: serverState.rootArchivedChildren ?? [],
        localOverrides: {},
        nodes: merged,
        ...recomputeDerived(merged)
      }
    })
  },

  applyServerNodeUpdate(id, fields) {
    set(state => {
      // Special-case: root archives are broadcast as node-updated with id='root'
      if (id === 'root') {
        if ('archivedChildren' in fields) {
          return { rootArchivedChildren: (fields as { archivedChildren: ArchivedNode[] }).archivedChildren }
        }
        return state
      }

      const existing = state.serverNodes[id]
      if (!existing) return state

      // Apply update to server nodes
      const updatedServer = { ...existing, ...fields } as NodeData
      const newServerNodes = { ...state.serverNodes, [id]: updatedServer }

      // Check if override is suppressing any of these fields
      const override = state.localOverrides[id]
      if (override) {
        const incomingFields = Object.keys(fields)
        const stillSuppressed = incomingFields.some(f => override.suppressFields.has(f))
        if (stillSuppressed) {
          // Server updated but override still active — keep override, just update server side
          const newNodes = mergeNodes(newServerNodes, state.localOverrides)
          return { serverNodes: newServerNodes, nodes: newNodes, ...recomputeDerived(newNodes) }
        }
      }

      const newNodes = mergeNodes(newServerNodes, state.localOverrides)
      return { serverNodes: newServerNodes, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  applyServerNodeAdd(node) {
    set(state => {
      const newServerNodes = { ...state.serverNodes, [node.id]: node }
      const newNodes = mergeNodes(newServerNodes, state.localOverrides)
      return { serverNodes: newServerNodes, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  applyServerNodeRemove(id) {
    set(state => {
      const { [id]: _removed, ...restServer } = state.serverNodes
      const { [id]: _removedOverride, ...restOverrides } = state.localOverrides
      const newNodes = mergeNodes(restServer, restOverrides)
      return { serverNodes: restServer, localOverrides: restOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  // --- Override management ---

  setOverride(id, fields, suppressFields) {
    set(state => {
      const newOverrides = {
        ...state.localOverrides,
        [id]: {
          fields: { ...state.localOverrides[id]?.fields, ...fields },
          suppressFields: new Set([...(state.localOverrides[id]?.suppressFields ?? []), ...suppressFields]),
          createdAt: Date.now()
        }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  },

  clearOverride(id, fields) {
    set(state => {
      const existing = state.localOverrides[id]
      if (!existing) return state

      if (!fields) {
        // Clear entire override for this node
        const { [id]: _, ...rest } = state.localOverrides
        const newNodes = mergeNodes(state.serverNodes, rest)
        return { localOverrides: rest, nodes: newNodes, ...recomputeDerived(newNodes) }
      }

      // Clear specific fields
      const newFields = { ...existing.fields }
      const newSuppress = new Set(existing.suppressFields)
      for (const f of fields) {
        delete (newFields as Record<string, unknown>)[f]
        newSuppress.delete(f)
      }

      if (newSuppress.size === 0) {
        const { [id]: _, ...rest } = state.localOverrides
        const newNodes = mergeNodes(state.serverNodes, rest)
        return { localOverrides: rest, nodes: newNodes, ...recomputeDerived(newNodes) }
      }

      const newOverrides = {
        ...state.localOverrides,
        [id]: { fields: newFields, suppressFields: newSuppress, createdAt: existing.createdAt }
      }
      const newNodes = mergeNodes(state.serverNodes, newOverrides)
      return { localOverrides: newOverrides, nodes: newNodes, ...recomputeDerived(newNodes) }
    })
  }
}))
