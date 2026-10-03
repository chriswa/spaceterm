import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TerminalCard } from './TerminalCard'
import { installFakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import { useAgentNamesStore } from '../stores/agentNamesStore'
import { asNodeId, asPtySessionId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * The receptionist's name for a surface, worn as a tag above its card. The
 * only route to the screen is `agentNamesStore`, keyed by node id.
 */

type TerminalCardProps = ComponentProps<typeof TerminalCard>

function props(overrides: Record<string, unknown> = {}): TerminalCardProps {
  return {
    id: asNodeId('term-1'),
    sessionId: asPtySessionId('term-1'),
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
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  } as unknown as TerminalCardProps
}

const TAG = '.card-shell__name-tag'

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
  useAgentNamesStore.setState({ names: {} })
})

afterEach(cleanup)

describe('the agent name tag', () => {
  it('is absent until the surface has a name, and follows it', () => {
    const { container } = render(<TerminalCard {...props()} />)
    expect(container.querySelector(TAG)).toBeNull()

    act(() => useAgentNamesStore.getState().setAll({ 'term-1': 'Kevin', 'term-2': 'Maria' }))
    expect(container.querySelector(TAG)?.textContent).toBe('Kevin')

    act(() => useAgentNamesStore.getState().setAll({ 'term-2': 'Maria' }))
    expect(container.querySelector(TAG)).toBeNull()
  })

  it('sits outside the title bar', () => {
    act(() => useAgentNamesStore.getState().setAll({ 'term-1': 'Kevin' }))
    const { container } = render(<TerminalCard {...props()} />)
    expect(container.querySelector(`.card-shell__head ${TAG}`)).toBeNull()
  })

  it('is left off the phone’s full-screen view', () => {
    act(() => useAgentNamesStore.getState().setAll({ 'term-1': 'Kevin' }))
    const { container } = render(<TerminalCard {...props({ chromeless: true })} />)
    expect(container.querySelector(TAG)).toBeNull()
  })
})
