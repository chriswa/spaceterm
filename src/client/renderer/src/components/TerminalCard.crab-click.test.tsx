import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TerminalCard } from './TerminalCard'
import { FakeBridge, installFakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId, asPtySessionId, asClaudeSessionId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * The agent mark floating in the band above a card is the only click target
 * that can *set* the unread flag by hand. Every other click path on a card
 * routes through focus, and focus clears the flag on the way in.
 *
 * Two rules hold it together, and both are easy to break by accident:
 *   1. the band never leaks a click to the canvas behind it, or a mis-click on
 *      an icon silently deselects or starts a pan;
 *   2. it only toggles in the states where the flag is actually visible.
 */

const nid = asNodeId
const pid = asPtySessionId

/** As in the lifecycle suite: `TerminalCardProps` is unexported and mostly irrelevant here. */
type TerminalCardProps = ComponentProps<typeof TerminalCard>

function props(overrides: Record<string, unknown> = {}): TerminalCardProps {
  return {
    id: nid('term-1'),
    sessionId: pid('term-1'),
    x: 0, y: 0, cols: 80, rows: 24, zIndex: 1, zoom: 1,
    focused: false,
    selected: false,
    anyNodeFocused: false,
    scrollMode: false,
    archivedChildren: [],
    agentType: 'claude',
    claudeState: 'stopped',
    claudeStatusUnread: false,
    claudeSessionHistory: [
      { claudeSessionId: asClaudeSessionId('sess-1'), reason: 'startup', timestamp: '2026-01-01T00:00:00Z' }
    ],
    onFocus: vi.fn(),
    onUnfocus: vi.fn(),
    onDisableScrollMode: vi.fn(),
    onForwardWheelToCanvas: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    onColorChange: vi.fn(),
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  } as unknown as TerminalCardProps
}

function crabIn(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.terminal-card__crab-behind')
  expect(el, 'the agent mark should be rendered').not.toBeNull()
  return el as HTMLElement
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})

afterEach(cleanup)

describe('clicking the agent mark above a card', () => {
  it('marks a read surface unread', () => {
    const { container } = render(<TerminalCard {...props()} />)
    fireEvent.click(crabIn(container))
    expect(bridge.lastCall('node.setClaudeStatusUnread')).toEqual([pid('term-1'), true])
  })

  it('marks an unread surface read', () => {
    const { container } = render(<TerminalCard {...props({ claudeStatusUnread: true })} />)
    fireEvent.click(crabIn(container))
    expect(bridge.lastCall('node.setClaudeStatusUnread')).toEqual([pid('term-1'), false])
  })

  it('targets the pty session, which diverges from the node id after a restart', () => {
    const { container } = render(<TerminalCard {...props({ id: nid('node-a'), sessionId: pid('pty-b') })} />)
    fireEvent.click(crabIn(container))
    expect(bridge.lastCall('node.setClaudeStatusUnread')?.[0]).toBe(pid('pty-b'))
  })

  it('does not focus the card', () => {
    const onFocus = vi.fn()
    const { container } = render(<TerminalCard {...props({ onFocus })} />)
    fireEvent.click(crabIn(container))
    fireEvent.mouseDown(crabIn(container))
    expect(onFocus).not.toHaveBeenCalled()
  })

  describe('in a state where the unread flag is invisible', () => {
    for (const claudeState of ['working', 'working_background']) {
      it(`does nothing while ${claudeState}`, () => {
        const { container } = render(<TerminalCard {...props({ claudeState })} />)
        fireEvent.click(crabIn(container))
        expect(bridge.callsTo('node.setClaudeStatusUnread')).toEqual([])
      })
    }

    it('does nothing while asleep', () => {
      const { container } = render(<TerminalCard {...props({ claudeStatusAsleep: true })} />)
      fireEvent.click(crabIn(container))
      expect(bridge.callsTo('node.setClaudeStatusUnread')).toEqual([])
    })

    it('still swallows the click rather than letting it deselect or pan', () => {
      // The whole point of the band: a mis-click on an icon must not fall
      // through to the canvas, even when the click itself is a no-op.
      const onBackgroundClick = vi.fn()
      const onBackgroundMouseDown = vi.fn()
      const { container } = render(
        <div onClick={onBackgroundClick} onMouseDown={onBackgroundMouseDown}>
          <TerminalCard {...props({ claudeState: 'working' })} />
        </div>
      )
      fireEvent.mouseDown(crabIn(container))
      fireEvent.click(crabIn(container))
      expect(onBackgroundMouseDown).not.toHaveBeenCalled()
      expect(onBackgroundClick).not.toHaveBeenCalled()
    })
  })

  describe('right-clicking it, to move between finished and finishing background work', () => {
    it('takes dismissed background work back up on a stopped surface', () => {
      const { container } = render(<TerminalCard {...props({ claudeDismissedBackground: 2 })} />)
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.lastCall('node.setClaudeStatusBackground')).toEqual([pid('term-1'), true])
    })

    it('stops waiting on a yellow surface', () => {
      const { container } = render(<TerminalCard {...props({ claudeState: 'working_background' })} />)
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.lastCall('node.setClaudeStatusBackground')).toEqual([pid('term-1'), false])
    })

    it('offers nothing on a stopped surface that has dismissed nothing', () => {
      // No background work was ever dismissed here, so there is nothing to wait
      // for — and inventing a task to represent the hunch is exactly what the
      // ledger forbids.
      const { container } = render(<TerminalCard {...props({ claudeDismissedBackground: 0 })} />)
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.callsTo('node.setClaudeStatusBackground')).toEqual([])
    })

    it('offers nothing while asleep, where neither colour is legible', () => {
      const { container } = render(
        <TerminalCard {...props({ claudeStatusAsleep: true, claudeDismissedBackground: 2 })} />
      )
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.callsTo('node.setClaudeStatusBackground')).toEqual([])
    })

    it('offers nothing while Claude is working', () => {
      const { container } = render(
        <TerminalCard {...props({ claudeState: 'working', claudeDismissedBackground: 2 })} />
      )
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.callsTo('node.setClaudeStatusBackground')).toEqual([])
    })

    it('swallows the event so the canvas menu never opens over the card', () => {
      const onBackgroundContextMenu = vi.fn()
      const { container } = render(
        <div onContextMenu={onBackgroundContextMenu}>
          <TerminalCard {...props({ claudeState: 'working' })} />
        </div>
      )
      fireEvent.contextMenu(crabIn(container))
      expect(onBackgroundContextMenu).not.toHaveBeenCalled()
    })

    it('leaves the unread flag alone', () => {
      const { container } = render(<TerminalCard {...props({ claudeDismissedBackground: 2 })} />)
      fireEvent.contextMenu(crabIn(container))
      expect(bridge.callsTo('node.setClaudeStatusUnread')).toEqual([])
    })
  })

  it('is not offered on a plain shell, which shows no agent mark at all', () => {
    const { container } = render(
      <TerminalCard {...props({ agentType: undefined, claudeState: undefined, claudeSessionHistory: [] })} />
    )
    expect(container.querySelector('.terminal-card__crab-behind')).toBeNull()
  })
})
