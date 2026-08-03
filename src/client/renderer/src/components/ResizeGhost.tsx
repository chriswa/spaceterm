import { useEffect, useRef } from 'react'
import { useNodeStore } from '../stores/nodeStore'
import { useResizeStore } from '../stores/resizeStore'
import { terminalSnapshotCanvases } from './TerminalCard'
import {
  terminalPixelSize, CELL_WIDTH, CELL_HEIGHT,
  CARD_BORDER, BODY_PADDING_TOP, CHROME_H, FOOTER_HEIGHT
} from '../lib/constants'

/**
 * Everything above the terminal body — border, title bar, its padding and
 * border. Taken as the remainder of the chrome rather than re-added from the
 * sub-constants, so the two blocks below always sum to exactly what
 * `terminalPixelSize` reserved.
 */
const HEADER_BLOCK = CHROME_H - FOOTER_HEIGHT

/** Where the card's body starts across: its border, then its padding. */
const CONTENT_INSET = CARD_BORDER + BODY_PADDING_TOP

/**
 * The preview drawn while a surface is being resized.
 *
 * Centre-anchored, like the card it stands for: a card is positioned at
 * `x - width/2`, so the preview grows away from the surface's centre in every
 * direction and settling on it produces exactly this rectangle.
 *
 * It shows the surface's current content, copied as pixels from the card's own
 * snapshot canvas and pinned to the top-left of the body — where a terminal's
 * first row and column live. So shrinking truncates the content on the right
 * and bottom exactly as the smaller grid will, and growing leaves bare purple
 * where the new space would be. Numbers alone do not tell you whether 200
 * columns is what you want; the old screen sitting inside the new outline does.
 *
 * The card underneath hides itself while this is up (see
 * `terminal-card--resize-source`), so what is on screen is only ever this.
 */
export function ResizeGhost(): React.ReactElement | null {
  const resizingNodeId = useResizeStore(s => s.resizingNodeId)
  const draft = useResizeStore(s => s.draft)
  const node = useNodeStore(s => (resizingNodeId ? s.nodes[resizingNodeId] : undefined))
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const isTerminal = !!resizingNodeId && node?.type === 'terminal'
  // Before the pointer has moved, stand exactly on the current size — so the
  // mode opens showing "this is what you have" rather than a jump.
  const cols = isTerminal ? (draft?.cols ?? node.cols) : 0
  const rows = isTerminal ? (draft?.rows ?? node.rows) : 0

  useEffect(() => {
    if (!isTerminal || !resizingNodeId) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = Math.ceil(cols * CELL_WIDTH)
    const height = Math.ceil(rows * CELL_HEIGHT)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ctx.clearRect(0, 0, width, height)

    // Copy only what fits. drawImage would happily scale the source to the
    // destination, and a stretched preview is worse than a truncated one — the
    // whole point is to judge how much of this content the new size holds.
    const source = terminalSnapshotCanvases.get(resizingNodeId)
    if (source && source.width > 0 && source.height > 0) {
      const w = Math.min(source.width, width)
      const h = Math.min(source.height, height)
      ctx.drawImage(source, 0, 0, w, h, 0, 0, w, h)
    }
  }, [isTerminal, resizingNodeId, cols, rows])

  if (!isTerminal || !node) return null

  const { width, height } = terminalPixelSize(cols, rows)
  const grew = cols * rows >= node.cols * node.rows

  return (
    <div
      className="resize-ghost"
      style={{
        position: 'absolute',
        left: node.x - width / 2,
        top: node.y - height / 2,
        width,
        height,
        pointerEvents: 'none',
        zIndex: 10_000,
      }}
    >
      <div className={`resize-ghost__readout${grew ? '' : ' resize-ghost__readout--shrinking'}`}>
        {cols} × {rows}
      </div>
      {/* Stand-ins for the title bar and footer, so the outline accounts for
          the chrome the real card spends that space on. */}
      <div className="resize-ghost__bar" style={{ height: HEADER_BLOCK }} />
      <canvas
        ref={canvasRef}
        className="resize-ghost__content"
        style={{
          width: Math.ceil(cols * CELL_WIDTH),
          height: Math.ceil(rows * CELL_HEIGHT),
          marginLeft: CONTENT_INSET,
        }}
      />
      <div className="resize-ghost__bar" style={{ height: FOOTER_HEIGHT }} />
    </div>
  )
}
