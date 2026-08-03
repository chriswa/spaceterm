// --- Undo buffer entry types ---
import type { NodeId } from './ids'
import { assertNever } from './exhaustive'

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

export interface UndoResizeEntry {
  kind: 'resize'
  ts: number
  description: string
  nodeId: NodeId
  /** The grid before the resize — what an undo restores. */
  cols: number
  rows: number
  /** The grid the user chose — what a redo restores. */
  afterCols: number
  afterRows: number
}

export type UndoEntry = UndoMoveEntry | UndoArchiveEntry | UndoUnarchiveEntry | UndoResizeEntry

/**
 * Whether stepping this entry asks for a second keypress first.
 *
 * Cheap, self-evident changes go through immediately; ones that make a surface
 * appear or disappear ask, because an accidental Cmd+Z that archives something
 * reads as data loss.
 *
 * This used to be `entry.kind === 'move'` written inline in the undo and redo
 * key handlers, with the toast verb derived from a second inline ternary that
 * assumed only two other kinds existed — so a new kind silently inherited
 * "requires confirmation" and was labelled "Archive". Both questions live here
 * now, and both are exhaustive: adding a kind without answering them is a
 * compile error.
 */
export function undoNeedsConfirmation(entry: UndoEntry): boolean {
  switch (entry.kind) {
    case 'move':
    case 'resize':
      return false
    case 'archive':
    case 'unarchive':
      return true
    default:
      return assertNever(entry, 'undoNeedsConfirmation')
  }
}

/**
 * What the confirmation toast says stepping this entry will do. Only reached
 * for kinds that need confirming — the others never show a toast.
 */
export function undoConfirmationVerb(entry: UndoEntry, direction: 'undo' | 'redo'): string {
  switch (entry.kind) {
    case 'archive':
      return direction === 'undo' ? 'Unarchive' : 'Archive'
    case 'unarchive':
      return direction === 'undo' ? 'Archive' : 'Unarchive'
    case 'move':
    case 'resize':
      return direction === 'undo' ? 'Undo' : 'Redo'
    default:
      return assertNever(entry, 'undoConfirmationVerb')
  }
}
