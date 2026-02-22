import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColorPreset } from '../lib/color-presets'
import { COLOR_PRESETS } from '../lib/color-presets'
import type { ArchivedNode, TerminalSessionEntry } from '../../../../shared/state'
import { ArchiveBody } from './ArchiveBody'
import { SessionsBody } from './SessionsBody'
import { AddNodeBody } from './AddNodeBody'
import type { AddNodeType } from './AddNodeBody'
import { ExtraCliArgsBody } from './ExtraCliArgsBody'
import { AlertsBody } from './AlertsBody'
import { useNodeAlerts } from '../lib/node-alerts'
import foodIcon from '../assets/food.svg'

export interface NodeActionBarProps {
  nodeId: string
  preset?: ColorPreset
  focused: boolean
  width: number
  onShipIt?: (id: string) => void
  onFork?: (id: string) => void
  onExtraCliArgs?: (nodeId: string, extraCliArgs: string) => void
  extraCliArgs?: string
  onDiffPlans?: () => void
  showColorPicker?: boolean
  onColorChange: (id: string, color: string) => void
  pastSessions?: TerminalSessionEntry[]
  currentSessionIndex?: number
  onSessionsToggled?: (nodeId: string, open: boolean) => void
  onSessionRevive?: (nodeId: string, session: TerminalSessionEntry) => void
  archivedChildren: ArchivedNode[]
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onStartReparent?: (id: string) => void
  isReparenting?: boolean
  onAddNode?: (parentNodeId: string, type: AddNodeType) => void
  showClose?: boolean
  onClose: (id: string) => void
}

/**
 * Renders action buttons + popup panels for a node.
 * Used both inside CardShell's titlebar and in FloatingToolbar.
 *
 * `variant` controls popup close-on-unfocus behavior:
 *  - 'card' (default): popups close when the node loses focus
 *  - 'floating': popups stay open regardless of node focus state
 */
export function NodeActionBar({
  nodeId, preset, focused, width,
  onShipIt, onFork, onExtraCliArgs, extraCliArgs,
  onDiffPlans, showColorPicker, onColorChange,
  pastSessions, currentSessionIndex, onSessionsToggled, onSessionRevive,
  archivedChildren, onArchiveToggled, onUnarchive, onArchiveDelete,
  onStartReparent, isReparenting,
  onAddNode, showClose, onClose,
  variant = 'card',
  onActionInvoked,
}: NodeActionBarProps & {
  variant?: 'card' | 'floating'
  onActionInvoked?: () => void
}) {
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const archiveBtnRef = useRef<HTMLButtonElement>(null)
  const archiveBodyRef = useRef<HTMLDivElement>(null)
  const sessionsBtnRef = useRef<HTMLButtonElement>(null)
  const sessionsBodyRef = useRef<HTMLDivElement>(null)
  const [addNodeOpen, setAddNodeOpen] = useState(false)
  const addNodeBtnRef = useRef<HTMLButtonElement>(null)
  const addNodeBodyRef = useRef<HTMLDivElement>(null)
  const [cliArgsOpen, setCliArgsOpen] = useState(false)
  const cliArgsBtnRef = useRef<HTMLButtonElement>(null)
  const cliArgsBodyRef = useRef<HTMLDivElement>(null)
  const [alertsOpen, setAlertsOpen] = useState(false)
  const alertsBtnRef = useRef<HTMLButtonElement>(null)
  const alertsBodyRef = useRef<HTMLDivElement>(null)
  const alerts = useNodeAlerts()

  // Close archive when archives become empty
  useEffect(() => {
    if (archivedChildren.length === 0 && archiveOpen) {
      setArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
  }, [archivedChildren.length, archiveOpen, nodeId, onArchiveToggled])

  // Close alerts panel when alerts become empty
  useEffect(() => {
    if (alerts.length === 0 && alertsOpen) setAlertsOpen(false)
  }, [alerts.length, alertsOpen])

  // Close sessions panel when past sessions become empty
  useEffect(() => {
    if (pastSessions && pastSessions.length < 2 && sessionsOpen) {
      setSessionsOpen(false)
      onSessionsToggled?.(nodeId, false)
    }
  }, [pastSessions, sessionsOpen, nodeId, onSessionsToggled])

  // Close popups when node loses focus (card variant only)
  useEffect(() => {
    if (variant === 'floating') return
    if (!focused) {
      if (archiveOpen) setArchiveOpen(false)
      if (sessionsOpen) setSessionsOpen(false)
      if (addNodeOpen) setAddNodeOpen(false)
      if (cliArgsOpen) setCliArgsOpen(false)
      if (alertsOpen) setAlertsOpen(false)
    }
  }, [focused, archiveOpen, sessionsOpen, addNodeOpen, cliArgsOpen, alertsOpen, variant])

  // Dismiss archive on outside click
  useEffect(() => {
    if (!archiveOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (archiveBodyRef.current?.contains(target)) return
      if (archiveBtnRef.current?.contains(target)) return
      setArchiveOpen(false)
      onArchiveToggled(nodeId, false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [archiveOpen, nodeId, onArchiveToggled])

  // Dismiss sessions panel on outside click
  useEffect(() => {
    if (!sessionsOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (sessionsBodyRef.current?.contains(target)) return
      if (sessionsBtnRef.current?.contains(target)) return
      setSessionsOpen(false)
      onSessionsToggled?.(nodeId, false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [sessionsOpen, nodeId, onSessionsToggled])

  // Dismiss add-node dropdown on outside click
  useEffect(() => {
    if (!addNodeOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (addNodeBodyRef.current?.contains(target)) return
      if (addNodeBtnRef.current?.contains(target)) return
      setAddNodeOpen(false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [addNodeOpen])

  // Dismiss CLI args popup on outside click
  useEffect(() => {
    if (!cliArgsOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (cliArgsBodyRef.current?.contains(target)) return
      if (cliArgsBtnRef.current?.contains(target)) return
      setCliArgsOpen(false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [cliArgsOpen])

  // Dismiss alerts popup on outside click
  useEffect(() => {
    if (!alertsOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (alertsBodyRef.current?.contains(target)) return
      if (alertsBtnRef.current?.contains(target)) return
      setAlertsOpen(false)
    }
    document.addEventListener('mousedown', handler, { capture: true })
    return () => document.removeEventListener('mousedown', handler, { capture: true })
  }, [alertsOpen])

  // Close color picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const toggleAlerts = useCallback(() => {
    setArchiveOpen(false)
    setSessionsOpen(false)
    setAddNodeOpen(false)
    setCliArgsOpen(false)
    setAlertsOpen(prev => !prev)
  }, [])

  const toggleArchive = useCallback(() => {
    setSessionsOpen(false)
    setAddNodeOpen(false)
    setCliArgsOpen(false)
    setAlertsOpen(false)
    setArchiveOpen(prev => {
      const next = !prev
      onArchiveToggled(nodeId, next)
      return next
    })
  }, [nodeId, onArchiveToggled])

  const toggleSessions = useCallback(() => {
    setArchiveOpen(false)
    setAddNodeOpen(false)
    setCliArgsOpen(false)
    setAlertsOpen(false)
    setSessionsOpen(prev => {
      const next = !prev
      onSessionsToggled?.(nodeId, next)
      return next
    })
  }, [nodeId, onSessionsToggled])

  const toggleAddNode = useCallback(() => {
    setArchiveOpen(false)
    setSessionsOpen(false)
    setCliArgsOpen(false)
    setAlertsOpen(false)
    setAddNodeOpen(prev => !prev)
  }, [])

  const toggleCliArgs = useCallback(() => {
    setArchiveOpen(false)
    setSessionsOpen(false)
    setAddNodeOpen(false)
    setAlertsOpen(false)
    setCliArgsOpen(prev => !prev)
  }, [])

  const handleAddNodeSelect = useCallback((type: AddNodeType) => {
    setAddNodeOpen(false)
    onAddNode?.(nodeId, type)
    onActionInvoked?.()
  }, [nodeId, onAddNode, onActionInvoked])

  const handleCliArgsRestart = useCallback((args: string) => {
    setCliArgsOpen(false)
    onExtraCliArgs?.(nodeId, args)
    onActionInvoked?.()
  }, [nodeId, onExtraCliArgs, onActionInvoked])

  // Popups position absolute relative to .node-titlebar__actions (which has position: relative via CSS).
  // top: 100% drops them below the buttons row.
  const popupStyle = { top: '100%', marginTop: 4 }

  return (
    <div className="node-titlebar__actions">
      {alerts.length > 0 && (
        <button
          ref={alertsBtnRef}
          className="node-titlebar__alerts-btn"
          data-tooltip="Alerts"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleAlerts() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.5 L14.5 13 L1.5 13 Z" />
            <line x1="8" y1="6" x2="8" y2="9.5" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
      )}
      {onShipIt && (
        <button
          className="node-titlebar__shipit-btn"
          data-tooltip="Ship it — paste into parent terminal"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onShipIt(nodeId); onActionInvoked?.() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img src={foodIcon} alt="Ship it" width={14} height={14} style={{ filter: 'invert(1)' }} />
        </button>
      )}
      {onFork && (
        <button
          className="node-titlebar__fork-btn"
          data-tooltip="Fork session"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onFork(nodeId); onActionInvoked?.() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 13 L7 6" />
            <path d="M3 1 L3 5 Q3 6 7 6 Q11 6 11 5 L11 1" />
            <path d="M7 1 L7 6" />
          </svg>
        </button>
      )}
      {onExtraCliArgs && (
        <button
          ref={cliArgsBtnRef}
          className="node-titlebar__cli-args-btn"
          data-tooltip="Extra CLI arguments"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleCliArgs() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="node-titlebar__cli-args-text">&gt;_</span>
        </button>
      )}
      {onDiffPlans && (
        <button
          className="node-titlebar__diff-plans-btn"
          data-tooltip="Diff plan versions"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onDiffPlans(); onActionInvoked?.() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="2" x2="4" y2="12" />
            <line x1="10" y1="2" x2="10" y2="12" />
            <line x1="2" y1="5" x2="6" y2="5" />
            <line x1="8" y1="9" x2="12" y2="9" />
          </svg>
        </button>
      )}
      {showColorPicker && (
        <div style={{ position: 'relative' }} ref={pickerRef}>
          <button
            className="node-titlebar__color-btn"
            data-tooltip="Node color"
            style={preset ? { color: preset.titleBarFg } : undefined}
            onClick={(e) => { e.stopPropagation(); setPickerOpen(prev => !prev) }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
              <g transform="rotate(-45 7 7)">
                <ellipse cx="7" cy="2.5" rx="3.2" ry="1.5" />
                <path d="M3.8 2.5 L3.8 10" />
                <path d="M10.2 2.5 L10.2 10" />
                <path d="M3.8 10 Q7 12.5 10.2 10" />
              </g>
              <path d="M1.3 5.4 L1.3 10.5" strokeWidth="1" />
            </svg>
          </button>
          {pickerOpen && (
            <div className="node-titlebar__color-picker" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="node-titlebar__color-swatch node-titlebar__color-swatch--inherit"
                data-tooltip="Inherit from parent"
                onClick={(e) => { e.stopPropagation(); onColorChange(nodeId, 'inherit'); setPickerOpen(false); onActionInvoked?.() }}
              />
              {COLOR_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className="node-titlebar__color-swatch"
                  style={{ backgroundColor: p.titleBarBg }}
                  onClick={(e) => { e.stopPropagation(); onColorChange(nodeId, p.id); setPickerOpen(false); onActionInvoked?.() }}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {pastSessions !== undefined && (
        <button
          ref={sessionsBtnRef}
          className="node-titlebar__sessions-btn"
          data-tooltip="Context history"
          disabled={pastSessions.length < 2}
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleSessions() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinecap="round">
            <circle cx="7" cy="2" r="2" stroke="none" />
            <line x1="7" y1="4" x2="7" y2="5" />
            <circle cx="7" cy="7" r="2" stroke="none" />
            <line x1="7" y1="9" x2="7" y2="10.3" />
            <circle cx="7" cy="12" r="1.5" fill="none" strokeWidth="1.4" />
          </svg>
        </button>
      )}
      <button
        ref={archiveBtnRef}
        className="node-titlebar__archive-btn"
        data-tooltip="Archived children"
        disabled={archivedChildren.length === 0}
        style={preset ? { color: preset.titleBarFg } : undefined}
        onClick={(e) => { e.stopPropagation(); toggleArchive() }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <svg width="18" height="18" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'absolute' }}>
          <path d="M2 1 L3 12 Q3 13 5 13 L9 13 Q11 13 11 12 L12 1" />
        </svg>
        <span className="node-titlebar__archive-count" style={archivedChildren.length >= 100 ? { fontSize: 7 } : archivedChildren.length >= 10 ? { fontSize: 8 } : undefined}>{archivedChildren.length}</span>
      </button>
      {onStartReparent && (
        <button
          className={`node-titlebar__reparent-btn${isReparenting ? ' node-titlebar__reparent-btn--active' : ''}`}
          data-tooltip="Reparent node"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onStartReparent(nodeId); onActionInvoked?.() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="11" x2="7" y2="4" />
            <path d="M4 7 L7 4 L10 7" />
            <line x1="3" y1="2" x2="11" y2="2" />
          </svg>
        </button>
      )}
      {onAddNode && (
        <button
          ref={addNodeBtnRef}
          className="node-titlebar__add-btn"
          data-tooltip="Add child node"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); toggleAddNode() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="7" y1="2" x2="7" y2="12" />
            <line x1="2" y1="7" x2="12" y2="7" />
          </svg>
        </button>
      )}
      {showClose && (
        <button
          className="node-titlebar__close"
          data-tooltip="Archive"
          style={preset ? { color: preset.titleBarFg } : undefined}
          onClick={(e) => { e.stopPropagation(); onClose(nodeId); onActionInvoked?.() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="3" x2="11" y2="11" />
            <line x1="11" y1="3" x2="3" y2="11" />
          </svg>
        </button>
      )}
      {archiveOpen && archivedChildren.length > 0 && (
        <div className="card-shell__archive-body" style={popupStyle} ref={archiveBodyRef}>
          <ArchiveBody
            parentId={nodeId}
            archives={archivedChildren}
            onUnarchive={onUnarchive}
            onArchiveDelete={onArchiveDelete}
          />
        </div>
      )}
      {sessionsOpen && pastSessions && pastSessions.length > 0 && (
        <div className="card-shell__sessions-body" style={popupStyle} ref={sessionsBodyRef}>
          <SessionsBody nodeId={nodeId} sessions={pastSessions} currentSessionIndex={currentSessionIndex} onRevive={onSessionRevive!} />
        </div>
      )}
      {addNodeOpen && onAddNode && (
        <div className="card-shell__add-node-body" style={popupStyle} ref={addNodeBodyRef}>
          <AddNodeBody onSelect={handleAddNodeSelect} />
        </div>
      )}
      {cliArgsOpen && onExtraCliArgs && (
        <div className="card-shell__cli-args-body" style={popupStyle} ref={cliArgsBodyRef}>
          <ExtraCliArgsBody initialValue={extraCliArgs ?? ''} onRestart={handleCliArgsRestart} />
        </div>
      )}
      {alertsOpen && alerts.length > 0 && (
        <div className="card-shell__alerts-body" style={popupStyle} ref={alertsBodyRef}>
          <AlertsBody alerts={alerts} />
        </div>
      )}
    </div>
  )
}
