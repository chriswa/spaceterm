import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DIRECTORY_HEIGHT } from '../lib/constants'
import { DIR_FOLDER_ART_HEIGHT, DIR_FOLDER_H_PADDING, DIR_MIN_FOLDER_WIDTH } from '../../../../shared/node-size'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import { blendHex } from '../lib/color-presets'
import type { ArchivedNode, GitStatus } from '../../../../shared/state'
import { gitBadges, formatGitStatusLine, type GitBadgeKind } from '../../../../shared/git-status'
import { CardShell } from './CardShell'
import { useNodeStore } from '../stores/nodeStore'
import { useReparentStore } from '../stores/reparentStore'
import { useFacet } from '../hooks/useFacet'
import { useRtsSelectStore } from '../stores/rtsSelectStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5
const DEFAULT_BG = '#1e1e2e'

function formatFetchAge(ts: number | null): string {
  if (ts === null) return '(never fetched)'
  const totalMinutes = Math.floor((Date.now() - ts) / 60_000)
  if (totalMinutes < 60) return `(${totalMinutes}m old)`
  const totalHours = Math.floor(totalMinutes / 60)
  if (totalHours < 24) return `(${totalHours}h old)`
  const days = Math.floor(totalHours / 24)
  return `(${days}d old)`
}

/**
 * The mark each badge draws, on a 24x24 grid. Strokes only, in `currentColor`,
 * so one CSS rule colours the whole set from the folder's own palette.
 *
 * Chosen to be readable as silhouettes from across the canvas, which is the
 * distance these are for: a fork for "not on the default branch", arrows for
 * the two directions the remote can be out of step, an M for modified tracked
 * files, and a plus for files git has not been told about.
 */
const BADGE_GLYPHS: Record<GitBadgeKind, ReactNode> = {
  'off-default': (
    <>
      <line x1="6.96" y1="4.44" x2="6.96" y2="14.52" />
      <circle cx="17.04" cy="6.96" r="2.52" />
      <circle cx="6.96" cy="17.04" r="2.52" />
      <path d="M17.04 9.48a7.56 7.56 0 0 1-7.56 7.56" />
    </>
  ),
  behind: (
    <>
      <line x1="12" y1="4.5" x2="12" y2="19" />
      <polyline points="6.5,13 12,19 17.5,13" />
    </>
  ),
  ahead: (
    <>
      <line x1="12" y1="19.5" x2="12" y2="5" />
      <polyline points="6.5,11 12,5 17.5,11" />
    </>
  ),
  dirty: <polyline points="5.5,18.5 5.5,5.5 12,14 18.5,5.5 18.5,18.5" />,
  untracked: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
}

/**
 * The badge row that hangs under the folder: one coin per thing the repo wants
 * noticing, centred, in the folder's own two colours.
 *
 * Absolutely positioned and non-interactive on purpose. The folder's width is
 * computed from its text on both the client and the server
 * (`directoryFolderWidth`), and the canvas behind the row stays draggable —
 * what the badges say in shorthand, the git status line above them says in
 * words, and its tooltip says in full.
 */
function GitBadges(
  { gitStatus, preset, onMouseDown }:
  { gitStatus: GitStatus; preset?: ColorPreset; onMouseDown: (e: React.MouseEvent) => void }
): ReactNode {
  const badges = gitBadges(gitStatus)
  if (badges.length === 0) return null
  const face = blendHex(preset?.titleBarBg ?? '#ffffff', '#000000', 0.8)
  const mark = preset?.terminalBg ?? DEFAULT_BG
  return (
    <div
      className="directory-card__badges"
      onMouseDown={onMouseDown}
      style={{ '--badge-face': face, '--badge-mark': mark } as React.CSSProperties}
    >
      {badges.map(badge => (
        <svg
          key={badge.kind}
          className="directory-card__badge"
          role="img"
          aria-label={badge.label}
          data-tooltip={badge.label}
          // The row hangs below the node, so the folder is what a tooltip above
          // it would cover.
          data-tooltip-placement="bottom"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle className="directory-card__badge-face" cx="12" cy="12" r="12" stroke="none" />
          {BADGE_GLYPHS[badge.kind]}
        </svg>
      ))}
    </div>
  )
}

function formatGitStatusTooltip(gs: GitStatus): string {
  // The badge row spelled out, so the marks under the folder have a legend.
  const parts: string[] = gitBadges(gs).map(b => b.label)
  parts.push(`branch: ${gs.branch ?? 'detached'}`)
  if (gs.conflicts) parts.push('merge conflicts')
  if (gs.lastFetchTimestamp !== null) {
    const totalMinutes = Math.floor((Date.now() - gs.lastFetchTimestamp) / 60_000)
    if (totalMinutes < 60) parts.push(`fetched ${totalMinutes}m ago`)
    else if (totalMinutes < 1440) parts.push(`fetched ${Math.floor(totalMinutes / 60)}h ago`)
    else parts.push(`fetched ${Math.floor(totalMinutes / 1440)}d ago`)
  } else {
    parts.push('never fetched')
  }
  return parts.join(' | ')
}

function folderPaths(w: number) {
  return {
    back: `M 16 26 L 16 18 Q 16 10 24 10 H 100 Q 108 10 112 18 L 125 26 L ${w - 24} 26 Q ${w - 16} 26 ${w - 16} 34 L ${w - 12} 130 Q ${w - 12} 138 ${w - 20} 138 L 20 138 Q 12 138 12 130 L 8 34 Q 8 26 16 26 Z`,
    front: `M 24 34 Q 16 34 16 42 L 12 130 Q 12 138 20 138 L ${w - 20} 138 Q ${w - 12} 138 ${w - 12} 130 L ${w - 8} 42 Q ${w - 8} 34 ${w - 16} 34 H 24 Z`,
  }
}

interface DirectoryCardProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  zoom: number
  cwd: string
  gitStatus?: GitStatus | null
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onCwdChange: (id: NodeId, cwd: string) => void
  onColorChange: (id: NodeId, color: string) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  onStartReparent?: (id: NodeId) => void
  onReparentTarget?: (id: NodeId) => void
  onAddNode?: (parentNodeId: NodeId, type: import('./AddNodeBody').AddNodeType) => void
  agentMeta?: { available: boolean; open: boolean; onToggle: (id: NodeId) => void }
  cameraRef: React.MutableRefObject<Camera>
}

export function DirectoryCard({
  id, x, y, zIndex, zoom, cwd, gitStatus, focused, selected, colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onCwdChange, onColorChange,
  onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, agentMeta, cameraRef
}: DirectoryCardProps) {
  // Where an unset node's colour comes from — see the `nodeTint` theme facet.
  const nodeTint = useFacet('nodeTint')
  const preset = resolvedPreset
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(cwd)
  const [error, setError] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const gitMeasureRef = useRef<HTMLSpanElement>(null)
  const [textWidth, setTextWidth] = useState(0)
  const [gitTextWidth, setGitTextWidth] = useState(0)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const rtsSelectActive = useRtsSelectStore(s => s.active)
  const freshlyCreated = useNodeStore(s => s.freshlyCreatedIds.has(id))

  // Auto-enter edit mode when freshly created and focused
  useEffect(() => {
    if (focused && freshlyCreated) {
      useNodeStore.getState().clearFreshlyCreated(id)
      setEditValue(cwd)
      setError(null)
      setEditing(true)
    }
  }, [focused, freshlyCreated, id, cwd])

  // Clear fetching indicator when the server sends updated git status
  const lastFetchTs = gitStatus?.lastFetchTimestamp ?? null
  useEffect(() => {
    setFetching(false)
  }, [lastFetchTs])

  // Compute the git status display text for measurement (includes fetch-age for width)
  const gitStatusCore = gitStatus ? formatGitStatusLine(gitStatus) : ''
  const fetchAgeText = gitStatus ? (fetching ? '(fetching…)' : formatFetchAge(gitStatus.lastFetchTimestamp)) : ''
  const gitStatusText = gitStatus === null
    ? 'not git controlled'
    : gitStatus
      ? `${gitStatusCore} ${fetchAgeText}`
      : ''

  // Measure text width via hidden span — works for both label and editing input
  useLayoutEffect(() => {
    if (!measureRef.current) return
    measureRef.current.textContent = (editing ? editValue : cwd) || ' '
    setTextWidth(measureRef.current.offsetWidth)
  }, [cwd, editing, editValue])

  // Measure git status text width via its own hidden span (different font size)
  useLayoutEffect(() => {
    if (!gitMeasureRef.current) return
    gitMeasureRef.current.textContent = gitStatusText || ' '
    setGitTextWidth(gitStatusText ? gitMeasureRef.current.offsetWidth : 0)
  }, [gitStatusText])

  const folderWidth = Math.max(DIR_MIN_FOLDER_WIDTH, Math.max(textWidth, gitTextWidth) + DIR_FOLDER_H_PADDING)

  // The folder artwork is authored in its own coordinate space, DIR_FOLDER_ART_HEIGHT
  // tall — folderPaths hardcodes vertical coordinates against it. Divide the world
  // width by the same factor so the viewBox keeps the card's exact aspect ratio; the
  // svg is width/height:100%, so it stretches the art to fill the node either way,
  // and a mismatched aspect would letterbox the folder inside its own card.
  const artWidth = folderWidth * (DIR_FOLDER_ART_HEIGHT / DIRECTORY_HEIGHT)
  const paths = folderPaths(artWidth)

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - folderWidth / 2, y: y - DIRECTORY_HEIGHT / 2, width: folderWidth, height: DIRECTORY_HEIGHT })
  }, [focused, id, x, y, folderWidth, onNodeReady])

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus({ preventScroll: true })
      inputRef.current.select()
    }
  }, [editing])

  // Auto-size input based on content
  useEffect(() => {
    if (editing && measureRef.current && inputRef.current) {
      measureRef.current.textContent = editValue || ' '
      inputRef.current.style.width = `${measureRef.current.offsetWidth + 4}px`
    }
  }, [editing, editValue])

  const startEditing = useCallback(() => {
    setEditValue(cwd)
    setError(null)
    setEditing(true)
  }, [cwd])

  const cancelEditing = useCallback(() => {
    setEditing(false)
    setError(null)
  }, [])

  const validateAndSave = useCallback(async () => {
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === cwd) {
      cancelEditing()
      return
    }
    try {
      const result = await window.api.node.validateDirectory(trimmed)
      if (result.valid) {
        onCwdChange(id, trimmed)
        setEditing(false)
        setError(null)
      } else {
        // Revert on invalid
        cancelEditing()
      }
    } catch {
      cancelEditing()
    }
  }, [editValue, cwd, id, onCwdChange, cancelEditing])

  const handleInputChange = useCallback(async (value: string) => {
    setEditValue(value)
    if (!value.trim()) {
      setError(null)
      return
    }
    try {
      const result = await window.api.node.validateDirectory(value.trim())
      setError(result.valid ? null : (result.error ?? 'Invalid path'))
    } catch {
      setError(null)
    }
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      validateAndSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }, [validateAndSave, cancelEditing])

  // Drag handler — same pattern as MarkdownCard
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return

    // Don't start drag if clicking the input while editing
    if (editing && (e.target as HTMLElement).closest('.directory-card__input')) return

    e.preventDefault()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = cameraRef.current.z
    const ctrlAtStart = e.ctrlKey
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey, ctrlAtStart, ev.shiftKey)
      }

      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        onDragEnd?.(id)
      } else if (useReparentStore.getState().reparentingNodeId) {
        onReparentTarget?.(id)
      } else if (!editing) {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <CardShell
      nodeId={id}
      x={x - folderWidth / 2}
      y={y - DIRECTORY_HEIGHT / 2}
      width={folderWidth}
      height={DIRECTORY_HEIGHT}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      agentMeta={agentMeta}
      isReparenting={reparentingNodeId === id}
      className={`directory-card ${focused ? 'directory-card--focused' : selected ? 'directory-card--selected' : ''}`}
      style={{
        backgroundColor: 'transparent',
        '--dir-fg': preset?.terminalBg ?? DEFAULT_BG,
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
      behindContent={
        gitStatus
          ? <GitBadges gitStatus={gitStatus} preset={preset} onMouseDown={handleMouseDown} />
          : null
      }
    >
      <svg
        className="directory-card__folder-svg"
        viewBox={`0 0 ${artWidth} ${DIR_FOLDER_ART_HEIGHT}`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={focused && !rtsSelectActive ? { color: nodeTint.borderColor(x, y), filter: `drop-shadow(0 0 4px ${nodeTint.borderColor(x, y)})` } : undefined}
      >
        <path d={paths.back} fill={blendHex(preset?.titleBarBg ?? '#ffffff', '#000000', 0.6)} stroke="currentColor" strokeWidth="1.5" />
        <path d={paths.front} fill={blendHex(preset?.titleBarBg ?? '#ffffff', '#000000', 0.8)} stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div className="directory-card__body">
        <span ref={measureRef} className="directory-card__measure" />
        <span ref={gitMeasureRef} className="directory-card__git-measure" />
        <div className="directory-card__content">
          {editing ? (
            <div className="directory-card__edit-container">
              <input
                ref={inputRef}
                className="directory-card__input"
                type="text"
                value={editValue}
                onChange={(e) => handleInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={validateAndSave}
              />
              {error && <div className="directory-card__error">{error}</div>}
            </div>
          ) : (
            <div className="directory-card__label" onClick={focused ? startEditing : undefined}>
              {cwd}
            </div>
          )}
          {gitStatus === null ? (
            <div className="directory-card__git-status directory-card__git-status--no-git">
              not git controlled
            </div>
          ) : gitStatus ? (
            <div
              className={`directory-card__git-status${gitStatus.conflicts ? ' directory-card__git-status--conflict' : ''}`}
              title={formatGitStatusTooltip(gitStatus)}
            >
              {gitStatusCore}{' '}
              <span
                className="directory-card__fetch-age"
                onClick={(e) => {
                  e.stopPropagation()
                  if (!fetching) {
                    setFetching(true)
                    window.api.node.directoryGitFetch(id)
                  }
                }}
              >
                {fetchAgeText}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </CardShell>
  )
}
