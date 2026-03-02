// --- Undo buffer entry types ---

export interface UndoMoveEntry {
  kind: 'move'
  ts: number
  description: string
  positions: Array<{ nodeId: string; x: number; y: number }>
  afterPositions: Array<{ nodeId: string; x: number; y: number }>
  parentId: string
}

export interface UndoArchiveEntry {
  kind: 'archive'
  ts: number
  description: string
  nodeId: string
  parentId: string
  reparentedChildIds: string[]
}

export interface UndoUnarchiveEntry {
  kind: 'unarchive'
  ts: number
  description: string
  nodeId: string
  parentId: string
}

export type UndoEntry = UndoMoveEntry | UndoArchiveEntry | UndoUnarchiveEntry
