// --- Undo buffer entry types ---
import type { NodeId } from './ids'

export interface UndoMoveEntry {
  kind: 'move'
  ts: number
  description: string
  positions: Array<{ nodeId: NodeId; x: number; y: number }>
  afterPositions: Array<{ nodeId: NodeId; x: number; y: number }>
  parentId: NodeId
}

export interface UndoArchiveEntry {
  kind: 'archive'
  ts: number
  description: string
  nodeId: NodeId
  parentId: NodeId
  reparentedChildIds: NodeId[]
}

export interface UndoUnarchiveEntry {
  kind: 'unarchive'
  ts: number
  description: string
  nodeId: NodeId
  parentId: NodeId
}

export type UndoEntry = UndoMoveEntry | UndoArchiveEntry | UndoUnarchiveEntry
