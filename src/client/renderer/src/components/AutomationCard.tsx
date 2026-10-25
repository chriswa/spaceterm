import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cron } from 'croner'
import { AUTOMATION_WIDTH, AUTOMATION_HEIGHT } from '../../../../shared/node-size'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import {
  AUTOMATION_OVERLAPS,
  AUTOMATION_OVERLAP_LABELS,
  parseTrigger,
  type AutomationOverlap
} from '../../../../shared/automation'
import { CardShell } from './CardShell'
import { useNodeStore } from '../stores/nodeStore'
import { useReparentStore } from '../stores/reparentStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5

interface AutomationCardProps {
  id: NodeId
  x: number
  y: number
  zIndex: number
  zoom: number
  trigger: string
  overlap: AutomationOverlap
  queued: number
  lastFiredAt?: number
  focused: boolean
  selected: boolean
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onTriggerChange: (id: NodeId, trigger: string) => void
  onOverlapChange: (id: NodeId, overlap: AutomationOverlap) => void
  onClearQueue: (id: NodeId) => void
  onColorChange: (id: NodeId, color: string) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  onStartReparent?: (id: NodeId) => void
  onReparentTarget?: (id: NodeId) => void
  onAddNode?: (parentNodeId: NodeId, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.MutableRefObject<Camera>
}

/** One line under the trigger field saying what it will do, or what is wrong with it. */
function describeTrigger(trigger: string): { text: string; error: boolean } {
  const parsed = parseTrigger(trigger)
  switch (parsed.kind) {
    case 'empty':
      return { text: 'Enter a cron expression or a custom_ event id', error: false }
    case 'invalid':
      return { text: parsed.error, error: true }
    case 'event':
      return { text: `Runs when a script fires ${parsed.eventId}`, error: false }
    case 'cron': {
      const next = new Cron(parsed.expression, { paused: true }).nextRun()
      return { text: next ? `Next run ${next.toLocaleString()}` : 'Never runs again', error: false }
    }
  }
}

export function AutomationCard({
  id, x, y, zIndex, zoom, trigger, overlap, queued, lastFiredAt, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onTriggerChange, onOverlapChange, onClearQueue, onColorChange,
  onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: AutomationCardProps) {
  const [draft, setDraft] = useState(trigger)
  const inputRef = useRef<HTMLInputElement>(null)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const freshlyCreated = useNodeStore(s => s.freshlyCreatedIds.has(id))

  // Follow the server while the field is not being edited.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(trigger)
  }, [trigger])

  useEffect(() => {
    if (focused && freshlyCreated) {
      useNodeStore.getState().clearFreshlyCreated(id)
      inputRef.current?.focus({ preventScroll: true })
    }
  }, [focused, freshlyCreated, id])

  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - AUTOMATION_WIDTH / 2, y: y - AUTOMATION_HEIGHT / 2, width: AUTOMATION_WIDTH, height: AUTOMATION_HEIGHT })
  }, [focused, id, x, y, onNodeReady])

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed !== trigger) onTriggerChange(id, trimmed)
    setDraft(trimmed)
  }, [draft, trigger, id, onTriggerChange])

  const status = useMemo(() => describeTrigger(draft), [draft])

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body')) return
    if (focused && (e.target as HTMLElement).closest('.automation-card__control')) return

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
      if (dragging) onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) onDragEnd?.(id)
      else if (useReparentStore.getState().reparentingNodeId) onReparentTarget?.(id)
      else onFocus(id)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <CardShell
      nodeId={id}
      x={x - AUTOMATION_WIDTH / 2}
      y={y - AUTOMATION_HEIGHT / 2}
      width={AUTOMATION_WIDTH}
      height={AUTOMATION_HEIGHT}
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
      isReparenting={reparentingNodeId === id}
      className={`automation-card ${focused ? 'automation-card--focused' : selected ? 'automation-card--selected' : ''}`}
      style={{
        // Opaque, unlike a title card's half-transparent surface: the edge to
        // the card's children runs underneath, and showing through a form it
        // reads as part of it.
        backgroundColor: '#000000',
        '--automation-fg': resolvedPreset?.titleBarBg ?? '#f0a94a',
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div className="automation-card__body">
        <div className="automation-card__head">
          <span className="automation-card__kind">Automation</span>
          <span className="automation-card__last">
            {lastFiredAt ? `Last run ${new Date(lastFiredAt).toLocaleString()}` : 'Never run'}
          </span>
        </div>
        <input
          ref={inputRef}
          className="automation-card__control automation-card__trigger"
          type="text"
          spellCheck={false}
          placeholder="0 9 * * 1-5  or  custom_my_event"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur() }
            else if (e.key === 'Escape') { e.preventDefault(); setDraft(trigger); inputRef.current?.blur() }
          }}
        />
        <div className={`automation-card__status ${status.error ? 'automation-card__status--error' : ''}`}>
          {status.text}
        </div>
        <div className="automation-card__row">
          <select
            className="automation-card__control automation-card__overlap"
            value={overlap}
            onChange={(e) => onOverlapChange(id, e.target.value as AutomationOverlap)}
          >
            {AUTOMATION_OVERLAPS.map((mode) => (
              <option key={mode} value={mode}>{AUTOMATION_OVERLAP_LABELS[mode]}</option>
            ))}
          </select>
          {(overlap === 'queue' || queued > 0) && (
            <span className="automation-card__queue">
              {queued} queued
              <button
                className="automation-card__control automation-card__clear"
                disabled={queued === 0}
                onClick={() => onClearQueue(id)}
              >
                Clear
              </button>
            </span>
          )}
        </div>
      </div>
    </CardShell>
  )
}
