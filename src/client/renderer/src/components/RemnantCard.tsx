import { useEffect, useMemo, useRef } from 'react'
import { REMNANT_WIDTH, REMNANT_HEIGHT } from '../lib/constants'
import { COLOR_PRESET_MAP } from '../lib/color-presets'
import { terminalSubtitle } from '../lib/node-title'
import { TerminalTitleBarContent } from './TerminalTitleBarContent'
import { CardShell } from './CardShell'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import { useReparentStore } from '../stores/reparentStore'

const DRAG_THRESHOLD = 5

interface RemnantCardProps {
  id: string
  x: number
  y: number
  zIndex: number
  zoom: number
  name?: string
  colorPresetId?: string
  archivedChildren: ArchivedNode[]
  shellTitleHistory?: string[]
  cwd?: string
  claudeSessionHistory?: ClaudeSessionEntry[]
  terminalSessions?: TerminalSessionEntry[]
  exitCode: number
  focused: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onResumeSession?: (remnantId: string, claudeSessionId: string) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
}

export function RemnantCard({
  id, x, y, zIndex, zoom, name, colorPresetId, archivedChildren, shellTitleHistory, cwd, claudeSessionHistory, terminalSessions, exitCode, focused,
  onFocus, onClose, onMove, onRename, onColorChange, onUnarchive, onArchiveDelete, onArchiveToggled, onResumeSession, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget
}: RemnantCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const propsRef = useRef({ x, y, zoom, id, onNodeReady })
  propsRef.current = { x, y, zoom, id, onNodeReady }

  // Build a lookup from claudeSessionId → shellTitleHistory
  const sessionTitleMap = useMemo(() => {
    const map = new Map<string, string[]>()
    if (terminalSessions) {
      for (const ts of terminalSessions) {
        if (ts.claudeSessionId) {
          map.set(ts.claudeSessionId, ts.shellTitleHistory)
        }
      }
    }
    return map
  }, [terminalSessions])

  // Notify parent when focused node is ready
  useEffect(() => {
    if (!focused) return
    propsRef.current.onNodeReady?.(id, { x: propsRef.current.x - REMNANT_WIDTH / 2, y: propsRef.current.y - REMNANT_HEIGHT / 2, width: REMNANT_WIDTH, height: REMNANT_HEIGHT })
  }, [focused, id])

  // Mousedown handler: drag-to-move or click-to-focus
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__close, .node-titlebar__color-btn, .terminal-card__left-area, .terminal-card__title-input, .node-titlebar__color-picker, .node-titlebar__archive-btn, .node-titlebar__reparent-btn, .archive-body')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = propsRef.current.zoom
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id)
      }

      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      if (dragging) {
        onDragEnd?.(id)
      } else if (useReparentStore.getState().reparentingNodeId) {
        onReparentTarget?.(id)
      } else {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  return (
    <CardShell
      nodeId={id}
      x={x - REMNANT_WIDTH / 2}
      y={y - REMNANT_HEIGHT / 2}
      width={REMNANT_WIDTH}
      height={REMNANT_HEIGHT}
      zIndex={zIndex}
      focused={focused}
      headVariant="visible"
      titleContent={
        <TerminalTitleBarContent
          name={name}
          shellTitleHistory={shellTitleHistory}
          cwd={cwd}
          preset={preset}
          id={id}
          onRename={onRename}
        />
      }
      headStyle={preset ? {
        backgroundColor: preset.titleBarBg,
        color: preset.titleBarFg,
        borderBottomColor: preset.titleBarBg
      } : undefined}
      preset={preset}
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      isReparenting={reparentingNodeId === id}
      className={`remnant-card ${focused ? 'remnant-card--focused' : ''}`}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div className="remnant-card__body">
        <div className="remnant-card__exit">exited ({exitCode})</div>
        {claudeSessionHistory && claudeSessionHistory.length > 0 && (
          <div className="remnant-card__sessions">
            <div className="remnant-card__sessions-header">Terminal Sessions</div>
            {[...claudeSessionHistory].reverse().map((entry, i) => {
              const titleHistory = sessionTitleMap.get(entry.claudeSessionId) ?? []
              const historyStr = terminalSubtitle(titleHistory)
              return (
                <div
                  key={i}
                  className={`terminal-card__session-entry terminal-card__session-entry--${entry.reason}`}
                >
                  <span
                    className={`terminal-card__session-reason${focused ? ' terminal-card__session-reason--clickable' : ''}`}
                    onClick={focused ? (e) => {
                      e.stopPropagation()
                      onResumeSession?.(id, entry.claudeSessionId)
                    } : undefined}
                    onMouseDown={focused ? (e) => e.stopPropagation() : undefined}
                  >
                    {entry.reason}
                  </span>
                  {historyStr && (
                    <span className="terminal-card__session-history"> &mdash; {historyStr}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="terminal-card__footer" style={preset ? { backgroundColor: preset.titleBarBg, color: preset.titleBarFg, borderTopColor: preset.titleBarBg } : undefined}>
        Surface ID: <span className="terminal-card__footer-id" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(id) }} onMouseDown={(e) => e.stopPropagation()}>{id.slice(0, 8)}</span>
      </div>
    </CardShell>
  )
}
