import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TerminalCard } from '@/components/TerminalCard'
import { useNodeStore } from '@/stores/nodeStore'
import type { Camera } from '@/lib/camera'
import { terminalPixelSize } from '../shared/node-size'
import { nodeDisplayTitle } from '@/lib/node-title'
import type { NodeId } from '../shared/ids'
import { KeyRow } from './KeyRow'

/**
 * One terminal surface, full screen.
 *
 * It is the desktop's own `TerminalCard`, focused — the same xterm, the same
 * attach and scrollback replay, the same input handling — scaled to the phone
 * and scrollable. The canvas keeps its snapshot card for the same surface (see
 * surfacePresenterStore), and gets snapshots back when this closes.
 *
 * The pty keeps its size. A phone resizing a surface would reflow it on the
 * laptop too, so this shows the 160-column screen as it is and lets you pan.
 */

const SCALE_KEY = 'mobile.terminalScale'
const MIN_SCALE = 0.35
const MAX_SCALE = 1.2

function storedScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY))
    if (v >= MIN_SCALE && v <= MAX_SCALE) return v
  } catch { /* private mode */ }
  return 0.6
}

const noop = () => undefined

export function TerminalView({ nodeId, onClose, onCompose }: {
  nodeId: NodeId
  onClose: () => void
  onCompose: () => void
}) {
  const node = useNodeStore((s) => s.nodes[nodeId])
  const [scale, setScale] = useState(storedScale)
  const cameraRef = useRef<Camera>({ x: 0, y: 0, z: scale })
  cameraRef.current = { x: 0, y: 0, z: scale }
  const shellRef = useRef<HTMLDivElement>(null)
  const [extent, setExtent] = useState({ width: 0, height: 0 })

  const terminal = node?.type === 'terminal' ? node : null
  const sessionId = terminal?.sessionId

  // Hand the surface back to the canvas card on the way out: this card held
  // the live subscription, and the canvas card is waiting on snapshots.
  useEffect(() => {
    if (!sessionId) return
    return () => window.api.node.setTerminalMode(sessionId, 'snapshot')
  }, [sessionId])

  useEffect(() => {
    try { localStorage.setItem(SCALE_KEY, String(scale)) } catch { /* private mode */ }
  }, [scale])

  // The card's chrome adds height the pixel size does not include; measure it.
  useLayoutEffect(() => {
    const shell = shellRef.current?.querySelector<HTMLElement>('.card-shell')
    if (!shell) return
    const measure = () => setExtent({ width: shell.offsetWidth, height: shell.offsetHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(shell)
    return () => ro.disconnect()
  }, [sessionId])

  if (!terminal) {
    return (
      <div className="mobile-term">
        <header className="mobile-term__bar">
          <button className="mobile-btn" onClick={onClose}>‹ Canvas</button>
          <span className="mobile-term__title">Surface gone</span>
        </header>
      </div>
    )
  }

  const size = terminalPixelSize(terminal.cols, terminal.rows)
  const zoomBy = (factor: number) =>
    setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(s * factor * 100) / 100)))

  const focusKeyboard = () => {
    shellRef.current?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus()
  }

  return (
    <div className="mobile-term">
      <header className="mobile-term__bar">
        <button className="mobile-btn" onClick={onClose}>‹ Canvas</button>
        <span className="mobile-term__title">{nodeDisplayTitle(terminal)}</span>
        <button className="mobile-btn" onClick={() => zoomBy(1 / 1.15)} aria-label="Smaller">A−</button>
        <button className="mobile-btn" onClick={() => zoomBy(1.15)} aria-label="Larger">A+</button>
        <button className="mobile-btn mobile-btn--accent" onClick={onCompose}>Compose</button>
      </header>
      <div className="mobile-term__scroll">
        <div style={{ width: (extent.width || size.width) * scale, height: (extent.height || size.height) * scale, position: 'relative' }}>
          <div
            ref={shellRef}
            className="mobile-term__card"
            style={{ transform: `scale(${scale})`, width: size.width, height: size.height }}
          >
            <TerminalCard
              id={terminal.id}
              sessionId={terminal.sessionId}
              x={size.width / 2}
              y={size.height / 2}
              cols={terminal.cols}
              rows={terminal.rows}
              zIndex={1}
              zoom={scale}
              name={terminal.name ?? undefined}
              colorPresetId={terminal.colorPresetId}
              shellTitleHistory={terminal.shellTitleHistory}
              cwd={terminal.cwd}
              focused
              selected
              anyNodeFocused
              claudeStatusUnread={terminal.claudeStatusUnread}
              claudeStatusAsleep={terminal.claudeStatusAsleep}
              scrollMode={false}
              onFocus={noop}
              onUnfocus={onClose}
              onDisableScrollMode={noop}
              onForwardWheelToCanvas={noop}
              onClose={noop}
              onMove={noop}
              onRename={noop}
              archivedChildren={terminal.archivedChildren}
              onColorChange={noop}
              onStampChange={noop}
              onOpenArchiveSearch={noop}
              claudeSessionHistory={terminal.claudeSessionHistory}
              agentType={terminal.agentType}
              claudeState={terminal.claudeState}
              claudeDismissedBackground={terminal.claudeDismissedBackground}
              claudeModel={terminal.claudeModel}
              claudeEffort={terminal.claudeEffort}
              claudeContextPercent={terminal.claudeContextPercent}
              claudeSessionLineCount={terminal.claudeSessionLineCount}
              ccStatus={terminal.ccStatus}
              ccWaitingFor={terminal.ccWaitingFor}
              terminalSessions={terminal.terminalSessions}
              extraCliArgs={terminal.extraCliArgs}
              lastInteractedAt={terminal.lastInteractedAt}
              cameraRef={cameraRef}
            />
          </div>
        </div>
      </div>
      <KeyRow sessionId={terminal.sessionId} onKeyboard={focusKeyboard} />
    </div>
  )
}
