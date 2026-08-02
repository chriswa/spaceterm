import { useRef, useEffect, useState } from 'react'
import { usePerfStore } from '../../stores/perfStore'
import { useFontStore, FONT_THEMES } from '../../stores/fontStore'
import { useCameraLockStore } from '../../stores/cameraLockStore'
import { useNotificationSoundStore } from '../../stores/notificationSoundStore'
import { useCopyCleanupStore } from '../../stores/copyCleanupStore'
import { useThemeStore } from '../../stores/themeStore'
import { usePowerMonitorStore } from '../../stores/powerMonitorStore'
import { resolveTheme } from '../../lib/theme/themes'
import { useThemes } from '../../hooks/useFacet'
import { useFps } from '../../hooks/useFps'
import { useToolbarMenu } from './useToolbarMenu'
import { showToast } from '../../lib/toast'
import { BugIcon, StopwatchIcon, CameraIcon, ScrollIcon, FullscreenIcon, LockIcon, BellIcon, DustpanIcon, KeycastIcon, GaugeIcon, ChipIcon } from './icons'

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
  const powerMonitor = usePowerMonitorStore(s => s.enabled)
  const togglePowerMonitor = usePowerMonitorStore(s => s.toggle)
  const menu = useToolbarMenu()

  return (
    <div className="toolbar__menu-group" ref={menu.ref}>
      <button
        className={'toolbar__btn' + (menu.open ? ' toolbar__btn--active' : '')}
        onClick={menu.toggle}
        data-tooltip="Debug tools"
        data-tooltip-no-flip
      >
        <BugIcon />
      </button>
      {menu.open && (
        <div className="toolbar__menu">
          <button
            className={'toolbar__menu-item' + (tracing ? ' toolbar__menu-item--active' : '')}
            onClick={() => { startTrace(); menu.close() }}
            disabled={tracing}
          >
            <StopwatchIcon />
            <span>{tracing ? 'Recording trace…' : 'Perf Trace'}</span>
          </button>
          <button
            className="toolbar__menu-item"
            onClick={() => { onDebugCapture(); menu.close() }}
          >
            <CameraIcon />
            <span>Camera Debug</span>
          </button>
          <button
            className="toolbar__menu-item"
            onClick={() => { onInertiaLogDump(); menu.close() }}
          >
            <ScrollIcon />
            <span>Inertia Log</span>
          </button>
          {/* These two stay open: each toggles something you want to see the
              state of, so closing the menu would hide the answer. */}
          <button
            className={'toolbar__menu-item' + (powerMonitor ? ' toolbar__menu-item--active' : '')}
            onClick={togglePowerMonitor}
          >
            <GaugeIcon />
            <span>Power Monitor</span>
          </button>
          <HighPerformanceGpuItem />
        </div>
      )}
    </div>
  )
}



/**
 * Toggle the discrete-GPU launch switch.
 *
 * Its own component, rather than more state inside `DebugDropdown`, because it
 * is the only toolbar control that cannot take effect when clicked: Chromium
 * parses its command line once at process start. So the item tracks two values
 * — what is stored and what the running process launched with — and says
 * "restart to apply" while they disagree. Reporting only the stored value
 * would show the flag as on while the app is demonstrably not using it, which
 * is exactly the confusion that makes an A/B comparison worthless.
 *
 * The restart is left to the user's ↻ button rather than done automatically:
 * exiting for a supervised restart only works under `npm run dev`, and quitting
 * the app instead would be a poor surprise.
 */
export function HighPerformanceGpuItem() {
  const [stored, setStored] = useState<boolean | null>(null)
  const [active, setActive] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.api.system.getLaunchPrefs(),
      window.api.system.getActiveLaunchPrefs(),
    ]).then(([next, running]) => {
      if (cancelled) return
      setStored(next.highPerformanceGpu)
      setActive(running.highPerformanceGpu)
    })
    return () => { cancelled = true }
  }, [])

  const toggle = () => {
    if (stored === null) return
    const next = !stored
    setStored(next)
    void window.api.system.setLaunchPrefs({ highPerformanceGpu: next }).then((prefs) => {
      setStored(prefs.highPerformanceGpu)
      showToast(
        prefs.highPerformanceGpu === active
          ? `High-performance GPU ${prefs.highPerformanceGpu ? 'on' : 'off'}`
          : `High-performance GPU ${prefs.highPerformanceGpu ? 'on' : 'off'} — restart to apply`,
      )
    })
  }

  const pending = stored !== null && active !== null && stored !== active

  return (
    <button
      className={'toolbar__menu-item' + (stored ? ' toolbar__menu-item--active' : '')}
      onClick={toggle}
      disabled={stored === null}
    >
      <ChipIcon />
      <span>
        High-Perf GPU
        {pending && <span className="toolbar__menu-note"> restart to apply</span>}
      </span>
    </button>
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

// The window fills the display's work area by default — frameless, but with the menu
// bar still showing. This toggles native fullscreen on top of that, which covers the
// menu bar too. Stored under a v2 key: under the old default the window launched
// fullscreen, so a legacy `true` doesn't mean the user asked to hide the menu bar.
const FULLSCREEN_KEY = 'toolbar.fullscreen.v2'

export function FullscreenToggle() {
  const [on, setOn] = useState(false)

  useEffect(() => {
    localStorage.removeItem('toolbar.fullscreen')
    const saved = localStorage.getItem(FULLSCREEN_KEY)
    if (saved !== null) {
      const desired = saved === 'true'
      window.api.window.setFullScreen(desired).then(() => setOn(desired))
    } else {
      window.api.window.isFullScreen().then(setOn)
    }
  }, [])

  const toggle = () => {
    const next = !on
    localStorage.setItem(FULLSCREEN_KEY, String(next))
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
  const menu = useToolbarMenu()

  return (
    <div className="toolbar__font-group" ref={menu.ref}>
      <button
        className={'toolbar__btn' + (proportional ? ' toolbar__btn--active' : '')}
        onClick={toggle}
        data-tooltip={proportional ? 'Proportional — Switch to monospace font' : 'Proportional — Switch to proportional font'}
        data-tooltip-no-flip
      >
        Aa
      </button>
      <button
        className={'toolbar__font-dropdown-btn' + (menu.open ? ' toolbar__font-dropdown-btn--open' : '')}
        onClick={menu.toggle}
        data-tooltip="Font theme"
        data-tooltip-no-flip
      >
        ▾
      </button>
      {menu.open && (
        <div className="toolbar__font-menu">
          {FONT_THEMES.map(t => (
            <button
              key={t.id}
              className={'toolbar__font-menu-item' + (t.id === themeId ? ' toolbar__font-menu-item--active' : '')}
              onClick={() => {
                setThemeId(t.id)
                if (!proportional) toggle()
                menu.close()
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

/**
 * Pick the theme.
 *
 * This replaced a `Good Gfx` on/off button. The toggle was really a choice
 * between two looks that happened to number two, and a third made that
 * obvious — so the widget lists every registered theme and stays open while you click
 * through them, which is the whole point when what you are judging is the
 * difference between them.
 */
export function ThemePicker() {
  const themeId = useThemeStore(s => s.themeId)
  const setThemeId = useThemeStore(s => s.setThemeId)
  // From the registry, not a constant: a mod may contribute themes, and may do
  // it after this component has already rendered once.
  const themes = useThemes()
  const menu = useToolbarMenu()

  return (
    <div className="toolbar__menu-group" ref={menu.ref}>
      <button
        className={'toolbar__btn' + (menu.open ? ' toolbar__btn--active' : '')}
        onClick={menu.toggle}
        data-tooltip={`Theme — ${resolveTheme(themeId).label}`}
        data-tooltip-no-flip
      >
        ✦
      </button>
      {menu.open && (
        <div className="toolbar__menu toolbar__menu--describing">
          {themes.map(t => (
            <button
              key={t.id}
              className={'toolbar__menu-item' + (t.id === themeId ? ' toolbar__menu-item--active' : '')}
              onClick={() => setThemeId(t.id)}
            >
              <span className="toolbar__menu-label">{t.label}</span>
              <span className="toolbar__menu-blurb">{t.blurb}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Host-driven buttons ---
//
// These three cannot be standalone: their state lives in App (a keyboard-driven
// overlay, an in-flight server restart) rather than in a store. That is the
// honest dividing line between what a mod could supply today and what it could
// not.

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
