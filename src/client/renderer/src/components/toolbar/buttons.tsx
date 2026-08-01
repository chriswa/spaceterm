import { useRef, useEffect, useState } from 'react'
import { usePerfStore } from '../../stores/perfStore'
import { useFontStore, FONT_THEMES } from '../../stores/fontStore'
import { useCameraLockStore } from '../../stores/cameraLockStore'
import { useNotificationSoundStore } from '../../stores/notificationSoundStore'
import { useCopyCleanupStore } from '../../stores/copyCleanupStore'
import { useFps } from '../../hooks/useFps'
import { BugIcon, StopwatchIcon, CameraIcon, ScrollIcon, FullscreenIcon, LockIcon, BellIcon, DustpanIcon, KeycastIcon } from './icons'

/**
 * The toolbar's buttons.
 *
 * All but `DebugDropdown` are *standalone*: each owns its own state through a
 * store or through `window.api`, and takes no props at all. That is not an
 * accident of style — it is what lets `registry.tsx` type them as widgets that
 * cannot reach the host, and it is the shape a mod-supplied button would have.
 */

export function DebugDropdown({ onDebugCapture, onInertiaLogDump }: {
  onDebugCapture: () => void
  onInertiaLogDump: () => void
}) {
  // Read the perf store here rather than taking it as a prop: the toolbar was
  // subscribing to `recording` on behalf of a child, so every trace start
  // re-rendered the whole bar.
  const tracing = usePerfStore(s => s.recording) === 'trace'
  const startTrace = usePerfStore(s => s.startTrace)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="toolbar__debug-group" ref={dropdownRef}>
      <button
        className={'toolbar__btn' + (open ? ' toolbar__btn--active' : '')}
        onClick={() => setOpen(o => !o)}
        data-tooltip="Debug tools"
        data-tooltip-no-flip
      >
        <BugIcon />
      </button>
      {open && (
        <div className="toolbar__debug-menu">
          <button
            className={'toolbar__debug-menu-item' + (tracing ? ' toolbar__debug-menu-item--active' : '')}
            onClick={() => { startTrace(); setOpen(false) }}
            disabled={tracing}
          >
            <StopwatchIcon />
            <span>{tracing ? 'Recording trace…' : 'Perf Trace'}</span>
          </button>
          <button
            className="toolbar__debug-menu-item"
            onClick={() => { onDebugCapture(); setOpen(false) }}
          >
            <CameraIcon />
            <span>Camera Debug</span>
          </button>
          <button
            className="toolbar__debug-menu-item"
            onClick={() => { onInertiaLogDump(); setOpen(false) }}
          >
            <ScrollIcon />
            <span>Inertia Log</span>
          </button>
        </div>
      )}
    </div>
  )
}



export function CameraLockToggle() {
  const locked = useCameraLockStore(s => s.locked)
  const toggle = useCameraLockStore(s => s.toggle)
  return (
    <button
      className={'toolbar__btn' + (locked ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={locked ? 'Camera Lock — Unlock auto-zoom on focus' : 'Camera Lock — Lock camera from auto-zoom on focus'}
      data-tooltip-no-flip
    >
      <LockIcon />
    </button>
  )
}

export function FullscreenToggle() {
  const [on, setOn] = useState(true)

  useEffect(() => {
    const saved = localStorage.getItem('toolbar.fullscreen')
    if (saved !== null) {
      const desired = saved === 'true'
      window.api.window.setFullScreen(desired).then(() => setOn(desired))
    } else {
      window.api.window.isFullScreen().then(setOn)
    }
  }, [])

  const toggle = () => {
    const next = !on
    localStorage.setItem('toolbar.fullscreen', String(next))
    window.api.window.setFullScreen(next).then(() => setOn(next))
  }

  return (
    <button
      className={'toolbar__btn' + (on ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={on ? 'Fullscreen — Exit fullscreen' : 'Fullscreen — Enter fullscreen'}
      data-tooltip-no-flip
    >
      <FullscreenIcon />
    </button>
  )
}

export function ProportionalFontToggle() {
  const proportional = useFontStore(s => s.proportional)
  const toggle = useFontStore(s => s.toggle)
  const themeId = useFontStore(s => s.themeId)
  const setThemeId = useFontStore(s => s.setThemeId)
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="toolbar__font-group" ref={dropdownRef}>
      <button
        className={'toolbar__btn' + (proportional ? ' toolbar__btn--active' : '')}
        onClick={toggle}
        data-tooltip={proportional ? 'Proportional — Switch to monospace font' : 'Proportional — Switch to proportional font'}
        data-tooltip-no-flip
      >
        Aa
      </button>
      <button
        className={'toolbar__font-dropdown-btn' + (open ? ' toolbar__font-dropdown-btn--open' : '')}
        onClick={() => setOpen(o => !o)}
        data-tooltip="Font theme"
        data-tooltip-no-flip
      >
        ▾
      </button>
      {open && (
        <div className="toolbar__font-menu">
          {FONT_THEMES.map(t => (
            <button
              key={t.id}
              className={'toolbar__font-menu-item' + (t.id === themeId ? ' toolbar__font-menu-item--active' : '')}
              onClick={() => {
                setThemeId(t.id)
                if (!proportional) toggle()
                setOpen(false)
              }}
            >
              <span className="toolbar__font-menu-label">{t.label}</span>
              <span className="toolbar__font-menu-preview" style={{ fontFamily: t.fontFamily, fontSize: t.fontSize, fontWeight: t.fontWeight }}>
                Abc 123
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}


export function NotificationSoundToggle() {
  const enabled = useNotificationSoundStore(s => s.enabled)
  const toggle = useNotificationSoundStore(s => s.toggle)
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={enabled ? 'Notification Sound — Disable sound on new unread surfaces' : 'Notification Sound — Play sound when surfaces need attention'}
      data-tooltip-no-flip
    >
      <BellIcon />
    </button>
  )
}


export function CopyCleanupToggle() {
  const enabled = useCopyCleanupStore(s => s.enabled)
  const toggle = useCopyCleanupStore(s => s.toggle)
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      onClick={toggle}
      data-tooltip={enabled ? 'Copy Cleanup — Disable to copy raw terminal selection (for capturing fixtures)' : 'Copy Cleanup — Enable to strip Claude Code prefixes and reflow paragraphs on copy'}
      data-tooltip-no-flip
    >
      <DustpanIcon />
    </button>
  )
}

// --- Host-driven buttons ---
//
// These four cannot be standalone: their state lives in App (a keyboard-driven
// overlay, a WebGL setting, an in-flight server restart) rather than in a
// store. That is the honest dividing line between what a mod could supply
// today and what it could not.

export function HelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="toolbar__btn" onClick={onClick} data-tooltip="Help (⌘?)" data-tooltip-no-flip>
      ?
    </button>
  )
}

export function RestartButton({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  return (
    <button
      className={'toolbar__btn' + (restarting ? ' toolbar__btn--active' : '')}
      onClick={onRestart}
      disabled={restarting}
      data-tooltip={restarting ? 'Restarting Spaceterm…' : 'Restart Spaceterm server'}
      data-tooltip-no-flip
    >
      ↻
    </button>
  )
}

export function GoodGfxToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      onClick={onToggle}
      data-tooltip={enabled ? 'Good Gfx — Switch to simple background shader' : 'Good Gfx — Switch to full background shader'}
      data-tooltip-no-flip
    >
      ✦
    </button>
  )
}

export function KeycastToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      onClick={onToggle}
      data-tooltip="Keycast — Show key presses on screen"
      data-tooltip-no-flip
    >
      <KeycastIcon />
    </button>
  )
}

// --- Status metrics ---

export function FpsMetric() {
  // useFps writes into the span directly; a state update per frame would make
  // the counter the most expensive thing on screen.
  const ref = useRef<HTMLSpanElement>(null)
  useFps(ref)
  return (
    <span className="toolbar__status-item toolbar__metric">
      <span ref={ref}>0</span> <span className="toolbar__metric-label">fps</span>
    </span>
  )
}

export function ZoomMetric({ zoom }: { zoom: number }) {
  return (
    <span className="toolbar__status-item toolbar__metric">
      {(zoom * 100).toFixed(2)}<span className="toolbar__metric-label">%</span>
    </span>
  )
}
