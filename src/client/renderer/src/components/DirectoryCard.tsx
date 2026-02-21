import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DIRECTORY_HEIGHT } from '../lib/constants'
import { DIR_FOLDER_H_PADDING, DIR_MIN_FOLDER_WIDTH } from '../../../../shared/node-size'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import { blendHex } from '../lib/color-presets'
import type { ArchivedNode, GitStatus } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useNodeStore } from '../stores/nodeStore'
import { useReparentStore } from '../stores/reparentStore'
import { angleBorderColor } from '../lib/angle-color'

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

function formatGitStatus(gs: GitStatus): string {
  const parts: string[] = []
  parts.push(gs.branch ?? 'detached')
  if (gs.ahead > 0) parts.push(`⇡${gs.ahead}`)
  if (gs.behind > 0) parts.push(`⇣${gs.behind}`)
  if (gs.staged > 0) parts.push(`+${gs.staged}`)
  if (gs.unstaged > 0) parts.push(`!${gs.unstaged}`)
  if (gs.untracked > 0) parts.push(`?${gs.untracked}`)
  if (gs.conflicts > 0) parts.push(`=${gs.conflicts}`)
  return parts.join(' ')
}

function formatGitStatusTooltip(gs: GitStatus): string {
  const parts: string[] = []
  parts.push(`branch: ${gs.branch ?? 'detached'}`)
  if (gs.ahead > 0) parts.push(`${gs.ahead} ahead`)
  if (gs.behind > 0) parts.push(`${gs.behind} behind`)
  if (gs.staged > 0) parts.push(`${gs.staged} staged`)
  if (gs.unstaged > 0) parts.push(`${gs.unstaged} modified`)
  if (gs.untracked > 0) parts.push(`${gs.untracked} untracked`)
  if (gs.conflicts > 0) parts.push(`${gs.conflicts} conflicts`)
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
  id: string
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
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number, metaKey?: boolean) => void
  onCwdChange: (id: string, cwd: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: string) => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
  onAddNode?: (parentNodeId: string, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.RefObject<Camera>
}

export function DirectoryCard({
  id, x, y, zIndex, zoom, cwd, gitStatus, focused, selected, colorPresetId, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onCwdChange, onColorChange,
  onUnarchive, onArchiveDelete, onArchiveToggled, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: DirectoryCardProps) {
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
  const gitStatusCore = gitStatus ? formatGitStatus(gitStatus) : ''
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
  const paths = folderPaths(folderWidth)

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - folderWidth / 2, y: y - DIRECTORY_HEIGHT / 2, width: folderWidth, height: DIRECTORY_HEIGHT })
  }, [focused, id, x, y, folderWidth, onNodeReady])

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
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
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey)
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
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      isReparenting={reparentingNodeId === id}
      className={`directory-card ${focused ? 'directory-card--focused' : selected ? 'directory-card--selected' : ''}`}
      style={{
        backgroundColor: 'transparent',
        '--dir-fg': preset?.terminalBg ?? DEFAULT_BG,
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <svg
        className="directory-card__folder-svg"
        viewBox={`0 0 ${folderWidth} 144`}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={focused ? { color: angleBorderColor(x, y), filter: `drop-shadow(0 0 4px ${angleBorderColor(x, y)})` } : undefined}
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
              className={`directory-card__git-status${gitStatus.conflicts > 0 ? ' directory-card__git-status--conflict' : ''}`}
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
