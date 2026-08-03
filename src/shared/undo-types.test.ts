import { describe, it, expect } from 'vitest'
import { undoNeedsConfirmation, undoConfirmationVerb, type UndoEntry } from './undo-types'
import { asNodeId } from './ids'

const NODE = asNodeId('n1')

const MOVE: UndoEntry = {
  kind: 'move', ts: 0, description: 'a card', parentId: NODE,
  positions: [], afterPositions: []
}
const ARCHIVE: UndoEntry = {
  kind: 'archive', ts: 0, description: 'a card', nodeId: NODE, parentId: NODE, reparentedChildIds: []
}
const UNARCHIVE: UndoEntry = {
  kind: 'unarchive', ts: 0, description: 'a card', nodeId: NODE, parentId: NODE
}
const RESIZE: UndoEntry = {
  kind: 'resize', ts: 0, description: 'a surface', nodeId: NODE,
  cols: 160, rows: 45, afterCols: 200, afterRows: 60
}

describe('undoNeedsConfirmation', () => {
  it('lets cheap, visible changes through immediately', () => {
    expect(undoNeedsConfirmation(MOVE)).toBe(false)
    expect(undoNeedsConfirmation(RESIZE)).toBe(false)
  })

  it('asks first before a surface appears or disappears', () => {
    expect(undoNeedsConfirmation(ARCHIVE)).toBe(true)
    expect(undoNeedsConfirmation(UNARCHIVE)).toBe(true)
  })

  it('throws on a kind nobody answered for, rather than guessing', () => {
    // The old inline `entry.kind === 'move'` test defaulted a new kind to
    // "needs confirmation" and mislabelled its toast. This is the guard.
    const rogue = { kind: 'recolour' } as unknown as UndoEntry
    expect(() => undoNeedsConfirmation(rogue)).toThrow('undoNeedsConfirmation: unhandled variant recolour')
  })
})

describe('undoConfirmationVerb', () => {
  it('names the effect of the step, not the entry', () => {
    expect(undoConfirmationVerb(ARCHIVE, 'undo')).toBe('Unarchive')
    expect(undoConfirmationVerb(ARCHIVE, 'redo')).toBe('Archive')
    expect(undoConfirmationVerb(UNARCHIVE, 'undo')).toBe('Archive')
    expect(undoConfirmationVerb(UNARCHIVE, 'redo')).toBe('Unarchive')
  })

  it('throws on an unknown kind', () => {
    const rogue = { kind: 'recolour' } as unknown as UndoEntry
    expect(() => undoConfirmationVerb(rogue, 'undo')).toThrow('undoConfirmationVerb: unhandled variant recolour')
  })
})
