import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { TerminalCard } from './TerminalCard'
import { installFakeBridge } from '../testing/fake-bridge'
import { useNodeStore } from '../stores/nodeStore'
import { useSpeakingStore } from '../stores/speakingStore'
import { asNodeId, asPtySessionId } from '../../../../shared/ids'
import type { Camera } from '../lib/camera'

/**
 * While Voice Operator reads a surface aloud, a white megaphone appears in the
 * band above the card. It is the canvas-side counterpart to the toolbar
 * bubble, and the only thing that puts it on screen is the speaking store —
 * which is fed over IPC and has no other reader, so nothing else would catch
 * the wiring coming loose.
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
    onOpenArchiveSearch: vi.fn(),
    cameraRef: { current: { x: 0, y: 0, z: 1 } as Camera },
    ...overrides
  } as unknown as TerminalCardProps
}

const MARK = '.terminal-card__speaking-mark'

function setSpeaking(nodeId: string, speaking: boolean): void {
  act(() => { useSpeakingStore.getState().setSpeaking(nid(nodeId), speaking, 'Zoe') })
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
  useSpeakingStore.setState({ speaking: {} })
})

afterEach(cleanup)

describe('the speaking megaphone above a card', () => {
  it('is absent on a silent surface', () => {
    const { container } = render(<TerminalCard {...props()} />)
    expect(container.querySelector(MARK)).toBeNull()
  })

  it('appears while the surface is speaking and goes away when it stops', () => {
    const { container } = render(<TerminalCard {...props()} />)

    setSpeaking('term-1', true)
    expect(container.querySelector(MARK)).not.toBeNull()

    setSpeaking('term-1', false)
    expect(container.querySelector(MARK)).toBeNull()
  })

  it('keys off the node id, so a sibling speaking leaves this card alone', () => {
    const { container } = render(<TerminalCard {...props({ id: nid('term-1') })} />)
    setSpeaking('term-2', true)
    expect(container.querySelector(MARK)).toBeNull()
  })

  it('leaves the agent mark in place', () => {
    const { container } = render(<TerminalCard {...props()} />)
    setSpeaking('term-1', true)
    expect(container.querySelector('.terminal-card__crab-behind')).not.toBeNull()
  })
})
