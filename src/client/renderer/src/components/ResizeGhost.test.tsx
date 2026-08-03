import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ResizeGhost } from './ResizeGhost'
import { useNodeStore } from '../stores/nodeStore'
import { useResizeStore } from '../stores/resizeStore'
import { terminalPixelSize } from '../lib/constants'
import type { NodeData } from '../../../../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID } from '../../../../shared/ids'

/**
 * The resize preview's geometry.
 *
 * Cards are centre-anchored — `CardShell` is positioned at `x - width/2` — so
 * the preview has to be too, or the outline the user settles on is not the card
 * they get. That is the whole contract here, and it is invisible in the
 * component's own arithmetic unless something checks it against
 * `terminalPixelSize`.
 */

const nid = asNodeId
const NODE = nid('term-1')

function terminal(overrides: Record<string, unknown> = {}): NodeData {
  return {
    type: 'terminal', id: NODE, parentId: ROOT_NODE_ID,
    x: 1000, y: 500, zIndex: 1, sessionId: asPtySessionId('term-1'),
    cols: 160, rows: 45, alive: true,
    claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: 0, terminalSessions: [], claudeSessionHistory: [],
    shellTitleHistory: [], archivedChildren: [], ...overrides
  } as unknown as NodeData
}

function ghostOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.resize-ghost')
}

beforeEach(() => {
  useNodeStore.setState({ nodes: { [NODE]: terminal() } })
  useResizeStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useResizeStore.getState().reset()
})

describe('ResizeGhost', () => {
  it('draws nothing when resize mode is not active', () => {
    const { container } = render(<ResizeGhost />)
    expect(ghostOf(container)).toBeNull()
  })

  it('opens at the surface’s current size, so the mode does not start with a jump', () => {
    useResizeStore.getState().startResize(NODE)
    const { container } = render(<ResizeGhost />)
    const { width, height } = terminalPixelSize(160, 45)
    expect(ghostOf(container)?.style.width).toBe(`${width}px`)
    expect(ghostOf(container)?.style.height).toBe(`${height}px`)
  })

  it('stays centred on the surface as it grows — the card is centre-anchored', () => {
    useResizeStore.getState().startResize(NODE)
    const { container, rerender } = render(<ResizeGhost />)

    useResizeStore.getState().setDraft({ cols: 300, rows: 80 })
    rerender(<ResizeGhost />)

    const { width, height } = terminalPixelSize(300, 80)
    const ghost = ghostOf(container)!
    // Same centre as the node (1000, 500), which is what settling will produce.
    expect(parseFloat(ghost.style.left) + width / 2).toBe(1000)
    expect(parseFloat(ghost.style.top) + height / 2).toBe(500)
  })

  it('reads out the size in cells, not pixels — cells are what the user is choosing', () => {
    useResizeStore.getState().startResize(NODE)
    useResizeStore.getState().setDraft({ cols: 212, rows: 60 })
    const { container } = render(<ResizeGhost />)
    expect(container.querySelector('.resize-ghost__readout')?.textContent).toBe('212 × 60')
  })

  it('marks shrinking apart from growing', () => {
    useResizeStore.getState().startResize(NODE)
    useResizeStore.getState().setDraft({ cols: 80, rows: 24 })
    const { container } = render(<ResizeGhost />)
    expect(container.querySelector('.resize-ghost__readout')?.className)
      .toContain('resize-ghost__readout--shrinking')
  })

  it('draws nothing for a node that vanished mid-resize', () => {
    useResizeStore.getState().startResize(NODE)
    useNodeStore.setState({ nodes: {} })
    const { container } = render(<ResizeGhost />)
    expect(ghostOf(container)).toBeNull()
  })

  it('never intercepts the pointer — the click that settles has to reach the window', () => {
    useResizeStore.getState().startResize(NODE)
    const { container } = render(<ResizeGhost />)
    expect(ghostOf(container)?.style.pointerEvents).toBe('none')
  })
})
