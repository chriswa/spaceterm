import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ResizeGhost } from './ResizeGhost'
import { terminalSnapshotCanvases } from './TerminalCard'
import { useNodeStore } from '../stores/nodeStore'
import { useResizeStore } from '../stores/resizeStore'
import { terminalPixelSize, CELL_WIDTH, CELL_HEIGHT } from '../lib/constants'
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

describe('the content ResizeGhost previews', () => {
  /** Stand in for a card's snapshot canvas, recording what gets copied out of it. */
  function fakeSource(width: number, height: number) {
    const source = document.createElement('canvas')
    source.width = width
    source.height = height
    const draws: unknown[][] = []
    const ctx = { clearRect: () => {}, drawImage: (...args: unknown[]) => { draws.push(args) } }
    return { source, draws, ctx }
  }

  /** The snapshot bitmap a card of this grid size would have registered. */
  function bitmapFor(cols: number, rows: number): [number, number] {
    return [Math.ceil(cols * CELL_WIDTH), Math.ceil(rows * CELL_HEIGHT)]
  }

  function withCanvas(width: number, height: number) {
    const { source, draws, ctx } = fakeSource(width, height)
    terminalSnapshotCanvases.set(NODE, source)
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      return this === source ? null : (ctx as unknown as CanvasRenderingContext2D)
    } as typeof original
    return { draws, restore: () => { HTMLCanvasElement.prototype.getContext = original } }
  }

  afterEach(() => {
    terminalSnapshotCanvases.delete(NODE)
  })

  it('copies the surface’s current screen into the preview at 1:1', () => {
    // Whatever the size being previewed, the copy is never scaled: a stretched
    // screen would misrepresent exactly the thing the preview exists to show.
    const { draws, restore } = withCanvas(...bitmapFor(160, 45))
    try {
      useResizeStore.getState().startResize(NODE)
      useResizeStore.getState().setDraft({ cols: 300, rows: 80 })
      render(<ResizeGhost />)
      const [, sx, sy, sw, sh, dx, dy, dw, dh] = draws.at(-1) as number[]
      expect([sx, sy, dx, dy]).toEqual([0, 0, 0, 0])
      expect([sw, sh]).toEqual([dw, dh])
    } finally { restore() }
  })

  it('truncates rather than shrinks when the new size is smaller', () => {
    const [sourceW, sourceH] = bitmapFor(160, 45)
    const { draws, restore } = withCanvas(sourceW, sourceH)
    try {
      useResizeStore.getState().startResize(NODE)
      useResizeStore.getState().setDraft({ cols: 80, rows: 24 })
      render(<ResizeGhost />)
      const [, , , sw, sh] = draws.at(-1) as number[]
      // Only as much of the old screen as the smaller grid can hold.
      expect(sw).toBeLessThan(sourceW)
      expect(sh).toBeLessThan(sourceH)
      expect(sw).toBeCloseTo(bitmapFor(80, 24)[0], 0)
    } finally { restore() }
  })

  it('copies the whole screen and leaves the rest bare when growing', () => {
    const [sourceW, sourceH] = bitmapFor(80, 24)
    const { draws, restore } = withCanvas(sourceW, sourceH)
    try {
      useResizeStore.getState().startResize(NODE)
      useResizeStore.getState().setDraft({ cols: 300, rows: 80 })
      render(<ResizeGhost />)
      const [, , , sw, sh] = draws.at(-1) as number[]
      expect([sw, sh]).toEqual([sourceW, sourceH])
    } finally { restore() }
  })

  it('draws nothing when the card has no canvas registered', () => {
    const { draws, restore } = withCanvas(...bitmapFor(160, 45))
    try {
      terminalSnapshotCanvases.delete(NODE)
      useResizeStore.getState().startResize(NODE)
      render(<ResizeGhost />)
      expect(draws).toEqual([])
    } finally { restore() }
  })

  it('reserves the height the card spends on its title bar and footer', () => {
    useResizeStore.getState().startResize(NODE)
    const { container } = render(<ResizeGhost />)
    const bars = container.querySelectorAll('.resize-ghost__bar')
    expect(bars).toHaveLength(2)
    const total = [...bars].reduce((sum, b) => sum + parseFloat((b as HTMLElement).style.height), 0)
    // The preview's outline accounts for the same chrome the real card does.
    expect(total).toBe(terminalPixelSize(160, 45).height - 45 * 16)
  })
})
