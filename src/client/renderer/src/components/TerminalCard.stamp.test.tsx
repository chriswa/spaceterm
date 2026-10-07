import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TerminalCard } from './TerminalCard'
import { installFakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId, asPtySessionId } from '../../../../shared/ids'
import type { AutoStamp, NodeData, NodeStamp } from '../../../../shared/state'
import type { Camera } from '../lib/camera'

/**
 * An agent surface's stamp: picked from the action bar, drawn to the left of
 * the card. The mark reads the node store, so these tests seed the store the
 * way a server patch would.
 */

const nid = asNodeId
const pid = asPtySessionId

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
    onFocus: vi.fn(),
    onUnfocus: vi.fn(),
    onDisableScrollMode: vi.fn(),
    onForwardWheelToCanvas: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    onColorChange: vi.fn(),
    onStampChange: vi.fn(),
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  } as unknown as TerminalCardProps
}

function setStamp(stamp: NodeStamp | undefined): void {
  act(() => {
    useNodeStore.setState({ nodes: { [nid('term-1')]: { id: nid('term-1'), type: 'terminal', stamp } as unknown as NodeData } })
  })
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})

afterEach(cleanup)

describe('a surface stamp', () => {
  it('draws nothing by default', () => {
    const { container } = render(<TerminalCard {...props()} />)
    expect(container.querySelector('.node-stamp')).toBeNull()
  })

  it('draws the chosen stamp beside the card, and "none" removes it', () => {
    const { container } = render(<TerminalCard {...props()} />)

    setStamp('star')
    expect(container.querySelector('.node-stamp--star')).not.toBeNull()

    setStamp('bang')
    expect(container.querySelector('.node-stamp--star')).toBeNull()
    expect(container.querySelector('.node-stamp--bang')).not.toBeNull()

    setStamp('none')
    expect(container.querySelector('.node-stamp')).toBeNull()
  })

  it('is chosen from the action bar picker', () => {
    const onStampChange = vi.fn()
    const { container } = render(<TerminalCard {...props({ focused: true, onStampChange })} />)

    fireEvent.click(container.querySelector('.node-titlebar__stamp-btn')!)
    const options = container.querySelectorAll('.node-titlebar__stamp-option')
    expect(options).toHaveLength(3)

    fireEvent.click(container.querySelector('.node-titlebar__stamp-option.node-stamp--bang')!)
    expect(onStampChange).toHaveBeenCalledWith(nid('term-1'), 'bang')
    expect(container.querySelector('.node-titlebar__stamp-picker')).toBeNull()
  })

  it('is not offered on a plain terminal', () => {
    const { container } = render(<TerminalCard {...props({ agentType: undefined, claudeState: undefined })} />)
    expect(container.querySelector('.node-titlebar__stamp-btn')).toBeNull()
  })
})

describe('an auto-stamp', () => {
  const SVG = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>'

  function setAutoStamp(stamp: NodeStamp | undefined, autoStamp: AutoStamp): void {
    act(() => {
      useNodeStore.setState({ nodes: { [nid('term-1')]: { id: nid('term-1'), type: 'terminal', stamp, autoStamp } as unknown as NodeData } })
    })
  }

  it('is drawn as a mask of its SVG, right of the card, with a manual stamp on the left', () => {
    const { container } = render(<TerminalCard {...props()} />)
    setAutoStamp('star', { title: 'Fix the parser', status: 'ready', svg: SVG, description: 'A wrench.', previousDescriptions: ['A wrench.'], costUsd: 0.01 })

    expect(container.querySelector('.node-stamp-side--left > .node-stamp--star')).not.toBeNull()
    const auto = container.querySelector('.node-stamp-side--right > .node-stamp-auto--ready') as HTMLElement
    expect(auto.style.maskImage).toContain(encodeURIComponent(SVG))
    expect(auto.innerHTML).toBe('')
    expect(auto.title).toBe('$0.010 spent')
    // Drawn in the label's colour, not the manual stamps' white.
    expect(auto.style.getPropertyValue('--node-stamp-auto-color')).not.toBe('')
  })

  it('asks for a different icon when clicked', () => {
    const bridge = installFakeBridge(globalThis as never)
    const { container } = render(<TerminalCard {...props()} />)
    setAutoStamp(undefined, { title: 'Fix the parser', status: 'ready', svg: SVG, description: 'A wrench.', previousDescriptions: [], costUsd: 0 })

    fireEvent.click(container.querySelector('.node-stamp-auto')!)
    expect(bridge.lastCall('node.regenerateAutoStamp')).toEqual([nid('term-1')])
  })

  it('does not ask again while an icon is being drawn', () => {
    const bridge = installFakeBridge(globalThis as never)
    const { container } = render(<TerminalCard {...props()} />)
    setAutoStamp(undefined, { title: 'Fix the parser', status: 'generating', previousDescriptions: [], costUsd: 0 })

    expect(container.querySelector('.node-stamp-auto--generating')).not.toBeNull()
    fireEvent.click(container.querySelector('.node-stamp-auto')!)
    expect(bridge.callsTo('node.regenerateAutoStamp')).toHaveLength(0)
  })

  it('shows the refresh arrow, not the old icon, while a replacement is drawn', () => {
    const { container } = render(<TerminalCard {...props()} />)
    setAutoStamp(undefined, { title: 'Fix the parser', status: 'generating', svg: SVG, description: 'A wrench.', previousDescriptions: ['A wrench.'], costUsd: 0.01 })

    const auto = container.querySelector('.node-stamp-auto--generating') as HTMLElement
    expect(auto.classList.contains('node-stamp-auto--empty')).toBe(false)
    expect(auto.style.maskImage).not.toContain(encodeURIComponent(SVG))
    expect(auto.style.maskImage).toContain(encodeURIComponent('stroke-linecap'))
  })
})
