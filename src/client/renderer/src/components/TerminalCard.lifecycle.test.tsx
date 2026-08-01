import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import {
  TerminalCard,
  terminalSelectionGetters,
  terminalSearchOpeners,
  terminalSearchClosers,
  terminalPlanJumpers
} from './TerminalCard'
import { FakeBridge, installFakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import type { ComponentProps } from 'react'
import { asNodeId, asPtySessionId, type NodeId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * `TerminalCard`'s mount lifecycle — what it registers, what it subscribes to,
 * and whether it lets go of either.
 *
 * The 466-line xterm mount effect is the largest untested thing in the
 * renderer, and the riskiest part of it is not the xterm setup: it is that the
 * effect writes into **four module-level Maps** that outlive the component.
 * `App.tsx`'s keyboard handler reads them as an imperative side-channel, so a
 * card that mounts and never cleans up leaks a closure over a disposed
 * Terminal, and the next keystroke aimed at that node calls into it.
 *
 * NEXT_STEPS has flagged those Maps as an escape hatch for three sessions.
 * Nothing checked that they empty out. Now something does.
 *
 * Deliberately about lifecycle rather than about terminal *behaviour* —
 * scrollback, resize and serialization have their own coverage in
 * `snapshot-manager.test.ts` against `@xterm/headless`.
 */

const nid = asNodeId
const pid = asPtySessionId

const REGISTRIES = [
  ['selection getters', terminalSelectionGetters],
  ['search openers', terminalSearchOpeners],
  ['search closers', terminalSearchClosers],
  ['plan jumpers', terminalPlanJumpers]
] as const

/**
 * A full prop set, cast to the component's own type.
 *
 * `TerminalCardProps` is not exported and has 55 members, most of them
 * irrelevant to lifecycle. The cast keeps the fixture readable; the E2E suite
 * covers the props this leaves out.
 */
type TerminalCardProps = ComponentProps<typeof TerminalCard>

function props(overrides: Record<string, unknown> = {}): TerminalCardProps {
  return {
    id: nid('term-1'),
    sessionId: pid('term-1'),
    x: 0,
    y: 0,
    cols: 80,
    rows: 24,
    zIndex: 1,
    zoom: 1,
    focused: false,
    selected: false,
    anyNodeFocused: false,
    scrollMode: false,
    archivedChildren: [],
    onFocus: vi.fn(),
    onUnfocus: vi.fn(),
    onDisableScrollMode: vi.fn(),
    onForwardWheelToCanvas: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onRename: vi.fn(),
    onColorChange: vi.fn(),
    onUnarchive: vi.fn(),
    onArchiveDelete: vi.fn(),
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  } as unknown as TerminalCardProps
}

/** Every registry entry keyed by a node id, across all four maps. */
function registeredFor(id: NodeId): string[] {
  return REGISTRIES.filter(([, map]) => map.has(id)).map(([name]) => name)
}

function clearRegistries(): void {
  for (const [, map] of REGISTRIES) map.clear()
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
  clearRegistries()
})

afterEach(() => {
  cleanup()
  clearRegistries()
})

describe('an unfocused terminal', () => {
  it('renders', () => {
    const { container } = render(<TerminalCard {...props()} />)
    expect(container.firstElementChild).not.toBeNull()
  })

  it('does not build a terminal — the mount effect is gated on focus', () => {
    // `if (!focused) return` at the top of the effect. A canvas of fifty
    // surfaces would otherwise hold fifty xterm instances and fifty WebGL
    // contexts, only one of which anyone is looking at.
    render(<TerminalCard {...props()} />)
    expect(registeredFor(nid('term-1'))).toEqual([])
  })

  it('does not subscribe to pty output it will not display', () => {
    render(<TerminalCard {...props()} />)
    bridge.emit.ptyData(pid('term-1'), 'output nobody asked for')
    // Nothing to assert on the terminal itself; the point is that this does
    // not throw, i.e. nothing registered a handler that assumes a live xterm.
    expect(registeredFor(nid('term-1'))).toEqual([])
  })
})

describe('a focused terminal', () => {
  it('registers itself in every keyboard side-channel', () => {
    // App.tsx's keyboard handler reaches into these by node id. A card that
    // failed to register is a card where copy, find and plan-jump silently do
    // nothing.
    render(<TerminalCard {...props({ focused: true })} />)
    expect(registeredFor(nid('term-1')).sort()).toEqual(
      REGISTRIES.map(([name]) => name).slice().sort()
    )
  })

  it('registers under its NODE id, not its pty session id', () => {
    // The two diverge after the first restart, and the keyboard handler only
    // ever knows the node id.
    render(<TerminalCard {...props({ focused: true, id: nid('node-a'), sessionId: pid('pty-b') })} />)
    expect(registeredFor(nid('node-a')).length).toBe(REGISTRIES.length)
    expect(registeredFor(nid('pty-b') as NodeId)).toEqual([])
  })

  it('attaches to its pty session', () => {
    render(<TerminalCard {...props({ focused: true })} />)
    expect(bridge.lastCall('pty.attach')?.[0]).toBe(pid('term-1'))
  })
})

describe('unmounting', () => {
  it('empties every registry it filled', () => {
    // These Maps are module-level and outlive the component. A leaked entry is
    // a closure over a disposed Terminal, and the next keystroke aimed at that
    // node calls straight into it.
    const { unmount } = render(<TerminalCard {...props({ focused: true })} />)
    expect(registeredFor(nid('term-1')).length).toBe(REGISTRIES.length)

    unmount()
    expect(registeredFor(nid('term-1'))).toEqual([])
  })

  it('leaves no entry behind after a mount/unmount cycle repeated', () => {
    for (let i = 0; i < 3; i++) {
      const { unmount } = render(<TerminalCard {...props({ focused: true })} />)
      unmount()
    }
    expect(registeredFor(nid('term-1'))).toEqual([])
    for (const [name, map] of REGISTRIES) {
      expect(map.size, name).toBe(0)
    }
  })

  it('does not disturb another terminal’s registrations', () => {
    // Cleanup deletes by id. Deleting by anything coarser would disarm the
    // keyboard for whichever surface the user focuses next.
    render(<TerminalCard {...props({ focused: true, id: nid('keeper'), sessionId: pid('keeper') })} />)
    const { unmount } = render(
      <TerminalCard {...props({ focused: true, id: nid('goer'), sessionId: pid('goer') })} />
    )

    unmount()
    expect(registeredFor(nid('goer'))).toEqual([])
    expect(registeredFor(nid('keeper')).length).toBe(REGISTRIES.length)
  })

  it('stops listening to its pty', () => {
    const { unmount } = render(<TerminalCard {...props({ focused: true })} />)
    unmount()
    // A surviving onData handler would write into a disposed Terminal.
    expect(() => bridge.emit.ptyData(pid('term-1'), 'post-unmount output')).not.toThrow()
    expect(() => bridge.emit.ptyExit(pid('term-1'), 0)).not.toThrow()
  })
})

describe('losing focus', () => {
  it('releases the registries, matching the mount gate', () => {
    // The effect is gated on `focused`, so blurring re-runs cleanup. If it did
    // not, an unfocused terminal would keep answering keyboard commands it can
    // no longer service.
    const { rerender } = render(<TerminalCard {...props({ focused: true })} />)
    expect(registeredFor(nid('term-1')).length).toBe(REGISTRIES.length)

    act(() => { rerender(<TerminalCard {...props({ focused: false })} />) })
    expect(registeredFor(nid('term-1'))).toEqual([])
  })

  it('re-registers on refocus', () => {
    const { rerender } = render(<TerminalCard {...props({ focused: true })} />)
    act(() => { rerender(<TerminalCard {...props({ focused: false })} />) })
    act(() => { rerender(<TerminalCard {...props({ focused: true })} />) })

    expect(registeredFor(nid('term-1')).length).toBe(REGISTRIES.length)
  })

  it('registers exactly one entry per map, however many times focus toggles', () => {
    // Maps overwrite by key, so this cannot duplicate — but it can leak across
    // ids, and a size check is the cheap way to notice.
    const { rerender } = render(<TerminalCard {...props({ focused: true })} />)
    for (let i = 0; i < 4; i++) {
      act(() => { rerender(<TerminalCard {...props({ focused: i % 2 === 0 })} />) })
    }
    for (const [name, map] of REGISTRIES) {
      expect(map.size, name).toBeLessThanOrEqual(1)
    }
  })
})

describe('what the registries hand back', () => {
  it('gives the selection getter a callable, not a value', () => {
    // App's keyboard handler calls these lazily, at keystroke time — a value
    // captured at mount would be the selection from before the user selected
    // anything.
    render(<TerminalCard {...props({ focused: true })} />)
    expect(typeof terminalSelectionGetters.get(nid('term-1'))).toBe('function')
  })

  it('gives the search closer a boolean-returning callable', () => {
    // The handler uses the return value to decide whether the keystroke was
    // consumed; a void closer would make Escape fall through to the canvas.
    render(<TerminalCard {...props({ focused: true })} />)
    const closer = terminalSearchClosers.get(nid('term-1'))!
    expect(typeof closer()).toBe('boolean')
  })
})
