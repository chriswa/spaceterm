import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cron } from 'croner'
import { AUTOMATION_WIDTH, AUTOMATION_HEIGHT } from '../../../../shared/node-size'
import { DEFAULT_PRESET, type ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode, AutomationRunStats } from '../../../../shared/state'
import {
  CUSTOM_EVENT_PREFIX,
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
  runStats?: AutomationRunStats
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

type TriggerKind = 'cron' | 'event'

/** Which kind a saved trigger is. The text alone decides it; the dropdown only says how to read what is typed. */
function triggerKindOf(trigger: string): TriggerKind {
  return trigger.trim().startsWith(CUSTOM_EVENT_PREFIX) ? 'event' : 'cron'
}

/**
 * The line under the trigger field: what it will do, or what is wrong with it,
 * judged as the kind the dropdown says. Croner's own message is long and
 * quotes the input back, so a bad cron gets a short one with croner's in the
 * tooltip.
 */
function describeTrigger(kind: TriggerKind, trigger: string): { text: string; detail?: string; error: boolean } {
  const trimmed = trigger.trim()
  if (kind === 'event') {
    if (!trimmed) return { text: 'Type an event id that starts with custom_', error: false }
    if (!trimmed.startsWith(CUSTOM_EVENT_PREFIX)) return { text: 'Event ids start with custom_', error: true }
  } else {
    if (!trimmed) return { text: 'Type a cron expression: minute hour day month weekday', error: false }
    if (trimmed.startsWith(CUSTOM_EVENT_PREFIX)) return { text: 'That is an event id. Choose Custom event.', error: true }
  }
  const parsed = parseTrigger(trimmed)
  switch (parsed.kind) {
    case 'empty':
      return { text: '', error: false }
    case 'invalid':
      return kind === 'cron'
        ? { text: 'Not a cron expression. Five fields: minute hour day month weekday, e.g. 0 9 * * 1-5', detail: parsed.error, error: true }
        : { text: parsed.error, error: true }
    case 'event':
      return { text: `Runs when a script fires ${parsed.eventId}`, error: false }
    case 'cron': {
      const next = new Cron(parsed.expression, { paused: true }).nextRun()
      return { text: next ? `Next run ${next.toLocaleString()}` : 'Never runs again', error: false }
    }
  }
}

function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens)
}

export function AutomationCard({
  id, x, y, zIndex, zoom, trigger, overlap, queued, lastFiredAt, runStats, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onClose, onMove, onTriggerChange, onOverlapChange, onClearQueue, onColorChange,
  onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onStartReparent, onReparentTarget, onAddNode, cameraRef
}: AutomationCardProps) {
  const [draft, setDraft] = useState(trigger)
  const [kind, setKind] = useState<TriggerKind>(() => triggerKindOf(trigger))
  const inputRef = useRef<HTMLInputElement>(null)
  const propsRef = useRef({ x, y, zoom, id })
  propsRef.current = { x, y, zoom, id }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const freshlyCreated = useNodeStore(s => s.freshlyCreatedIds.has(id))

  // Follow the server while the field is not being edited.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(trigger)
      if (trigger.trim()) setKind(triggerKindOf(trigger))
    }
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

  const status = useMemo(() => describeTrigger(kind, draft), [kind, draft])

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
        // The terminal background for the card's colour, at full opacity rather
        // than `cardSurfaceColor`'s half: the edge to the card's children runs
        // underneath, and showing through a form it reads as part of it.
        backgroundColor: resolvedPreset?.terminalBg ?? DEFAULT_PRESET.terminalBg,
        '--automation-fg': resolvedPreset?.titleBarBg ?? '#f0a94a',
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      <div className="automation-card__body">
        <div className="automation-card__head">
          <span className="automation-card__kind">Automation</span>
          <span className="automation-card__last">
            {lastFiredAt ? `Fired ${new Date(lastFiredAt).toLocaleString()}` : 'Never fired'}
          </span>
        </div>
        <div className="automation-card__trigger-row">
          <select
            className="automation-card__control automation-card__kind-select"
            aria-label="Trigger kind"
            value={kind}
            onChange={(e) => { setKind(e.target.value as TriggerKind); inputRef.current?.focus({ preventScroll: true }) }}
          >
            <option value="cron">Cron</option>
            <option value="event">Custom event</option>
          </select>
          <input
            ref={inputRef}
            className="automation-card__control automation-card__trigger"
            type="text"
            spellCheck={false}
            placeholder={kind === 'cron' ? '0 9 * * 1-5' : 'custom_my_event'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); inputRef.current?.blur() }
              else if (e.key === 'Escape') { e.preventDefault(); setDraft(trigger); inputRef.current?.blur() }
            }}
          />
        </div>
        <div className={`automation-card__status ${status.error ? 'automation-card__status--error' : ''}`} title={status.detail}>
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
        <div className="automation-card__stats">
          {runStats ? (
            <>
              <span>Last run {formatUsd(runStats.last.costUsd)} · {formatTokens(runStats.last.tokens)} tokens</span>
              <span>Total {formatUsd(runStats.totalCostUsd)} · {runStats.runs} {runStats.runs === 1 ? 'run' : 'runs'}</span>
            </>
          ) : (
            <span>No finished runs yet</span>
          )}
        </div>
      </div>
    </CardShell>
  )
}
