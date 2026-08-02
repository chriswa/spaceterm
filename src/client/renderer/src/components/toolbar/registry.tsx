import type { ReactNode } from 'react'
import type { NodeId } from '../../../../../shared/ids'
import type { CrabEntry } from '../../lib/crab-nav'
import { CrabGroup, type CrabNavEvent } from './CrabGroup'
import { GhRateLimitIndicator } from './GhRateLimitIndicator'
import { PowerMonitor } from './PowerMonitor'
import {
  CameraLockToggle,
  CopyCleanupToggle,
  DebugDropdown,
  FpsMetric,
  FullscreenToggle,
  HelpButton,
  KeycastToggle,
  NotificationSoundToggle,
  ProportionalFontToggle,
  RestartButton,
  ThemePicker,
  ZoomMetric
} from './buttons'

/**
 * The third of MODDING.md's Tier 0 registries, after `AgentDriver` and
 * `CardType`.
 *
 * The toolbar's problem was never that it had too many buttons; it was that
 * adding one meant editing the component, threading two more props from
 * `App.tsx`, and putting the button's markup in whatever spot in the JSX looked
 * right. Order, membership and wiring were all the same edit. Here they are a
 * list.
 *
 * ## The distinction the registry forced
 *
 * Writing this down asked the same question `AgentDriver`'s capability block
 * asked: what does a widget actually *need*? The answer split the toolbar in
 * two, and the split was sharper than expected.
 *
 * - **Standalone widgets** own their state — a zustand store, `localStorage`,
 *   `window.api`. There are nine of them, and they take *no props at all*.
 * - **Host widgets** need something that lives in `App.tsx`: an overlay
 *   toggled by a keyboard shortcut, an in-flight server restart, the crab-nav
 *   selection.
 *
 * That line is exactly the line between "a mod could supply this today" and
 * "it could not", and the type enforces it: a standalone widget's `render` is
 * declared `() => ReactNode`, and TypeScript refuses a function that takes the
 * host. Not a comment, a compile error.
 *
 * The nine standalone widgets are the evidence that a widget contract is
 * viable at all. Before this file it was not obvious there were any — every
 * button looked like it belonged to the toolbar because it was written inside
 * it.
 */

/** Where in the bar a widget sits. Rendering order within a slot is list order. */
export type ToolbarSlot = 'buttons' | 'status' | 'surfaces'

export const TOOLBAR_SLOTS = ['buttons', 'status', 'surfaces'] as const

/**
 * What `App.tsx` supplies. Only host widgets receive it.
 *
 * Every entry here is a prop the toolbar has to be given, so this interface
 * doubles as the bill for host coupling — the shorter it gets, the closer the
 * toolbar is to being assembled entirely from independent parts.
 */
export interface ToolbarHost {
  zoom: number
  onHelpClick: () => void
  keycastEnabled: boolean
  onKeycastToggle: () => void
  onDebugCapture: () => void
  onInertiaLogDump: () => void
  restartingSpaceterm: boolean
  onRestartSpaceterm: () => void
  crabs: CrabEntry[]
  onCrabClick: (nodeId: NodeId, metaKey: boolean) => void
  onCrabReorder: (order: NodeId[]) => void
  selectedNodeId: NodeId | null
  crabNavEvent: CrabNavEvent
}

interface ToolbarWidgetBase {
  /** Stable key. Also the React key, so it must not change between renders. */
  readonly id: string
  readonly slot: ToolbarSlot
}

/**
 * A widget that owns its own state and cannot reach the host.
 *
 * `render` deliberately takes no parameters: TypeScript rejects a function
 * that takes `ToolbarHost` where `() => ReactNode` is expected, so declaring a
 * widget standalone and then reading a host prop does not compile.
 */
export interface StandaloneToolbarWidget extends ToolbarWidgetBase {
  readonly kind: 'standalone'
  render(): ReactNode
}

/** A widget wired to `App.tsx` state. Not yet expressible as anything but first-party code. */
export interface HostToolbarWidget extends ToolbarWidgetBase {
  readonly kind: 'host'
  render(host: ToolbarHost): ReactNode
}

export type ToolbarWidget = StandaloneToolbarWidget | HostToolbarWidget

/**
 * The toolbar, as data. Order within a slot is the order shown.
 *
 * Adding a button is one entry here plus one component. Removing one is
 * deleting the entry — the 45% "wiring in shared files" tax MODDING.md measured
 * against commit `653cd1d` is, for this surface, zero.
 */
export const TOOLBAR_WIDGETS: readonly ToolbarWidget[] = [
  { id: 'help', slot: 'buttons', kind: 'host', render: (h) => <HelpButton onClick={h.onHelpClick} /> },
  { id: 'fullscreen', slot: 'buttons', kind: 'standalone', render: () => <FullscreenToggle /> },
  {
    id: 'restart',
    slot: 'buttons',
    kind: 'host',
    render: (h) => <RestartButton restarting={h.restartingSpaceterm} onRestart={h.onRestartSpaceterm} />
  },
  { id: 'camera-lock', slot: 'buttons', kind: 'standalone', render: () => <CameraLockToggle /> },
  {
    id: 'debug',
    slot: 'buttons',
    kind: 'host',
    render: (h) => <DebugDropdown onDebugCapture={h.onDebugCapture} onInertiaLogDump={h.onInertiaLogDump} />
  },
  { id: 'theme', slot: 'buttons', kind: 'standalone', render: () => <ThemePicker /> },
  {
    id: 'keycast',
    slot: 'buttons',
    kind: 'host',
    render: (h) => <KeycastToggle enabled={h.keycastEnabled} onToggle={h.onKeycastToggle} />
  },
  { id: 'notification-sound', slot: 'buttons', kind: 'standalone', render: () => <NotificationSoundToggle /> },
  { id: 'copy-cleanup', slot: 'buttons', kind: 'standalone', render: () => <CopyCleanupToggle /> },
  { id: 'proportional-font', slot: 'buttons', kind: 'standalone', render: () => <ProportionalFontToggle /> },

  { id: 'fps', slot: 'status', kind: 'standalone', render: () => <FpsMetric /> },
  { id: 'zoom', slot: 'status', kind: 'host', render: (h) => <ZoomMetric zoom={h.zoom} /> },
  // Renders nothing unless switched on from the debug menu.
  { id: 'power-monitor', slot: 'status', kind: 'standalone', render: () => <PowerMonitor /> },
  { id: 'gh-rate-limit', slot: 'status', kind: 'standalone', render: () => <GhRateLimitIndicator /> },

  {
    id: 'crab-group',
    slot: 'surfaces',
    kind: 'host',
    // Renders nothing when there are no surfaces; a widget returning null is
    // how "conditionally present" is expressed, rather than a flag on the entry.
    render: (h) => h.crabs.length === 0 ? null : (
      <CrabGroup
        crabs={h.crabs}
        onCrabClick={h.onCrabClick}
        onCrabReorder={h.onCrabReorder}
        selectedNodeId={h.selectedNodeId}
        crabNavEvent={h.crabNavEvent}
      />
    )
  }
]

/** The widgets in one slot, in display order. */
export function widgetsInSlot(slot: ToolbarSlot, widgets: readonly ToolbarWidget[] = TOOLBAR_WIDGETS): ToolbarWidget[] {
  return widgets.filter((w) => w.slot === slot)
}

/**
 * Render a widget, giving it the host only if it declared it needs one.
 *
 * The host is not passed to a standalone widget even though doing so would be
 * harmless — a standalone widget that starts using it should fail to compile,
 * and that only holds if it is never handed one.
 */
export function renderToolbarWidget(widget: ToolbarWidget, host: ToolbarHost): ReactNode {
  return widget.kind === 'standalone' ? widget.render() : widget.render(host)
}
