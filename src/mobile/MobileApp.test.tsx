import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { useNodeStore } from '@/stores/nodeStore'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useSummaryChatStore } from '@/stores/summaryChatStore'
import { asNodeId, asPtySessionId, ROOT_NODE_ID } from '../shared/ids'
import type { TerminalNodeData } from '../shared/state'
import { MobileApp } from './MobileApp'

const SURFACE = asNodeId('c35ae62d-aa5a-46d1-8e03-086f95cd612e')

const terminal: TerminalNodeData = {
  id: SURFACE, parentId: ROOT_NODE_ID, x: 0, y: 0, zIndex: 1, archivedChildren: [], type: 'terminal', alive: true,
  sessionId: asPtySessionId('pty-1'), cols: 80, rows: 24, claudeState: 'stopped', claudeStatusUnread: false,
  claudeStatusAsleep: false, sortOrder: 0, terminalSessions: [], claudeSessionHistory: [], shellTitleHistory: [],
} as TerminalNodeData

/** A tap on the terminal view, which opens the composer. */
function tap(area: Element): void {
  act(() => {
    area.dispatchEvent(new TouchEvent('touchstart', { touches: [{ clientX: 100, clientY: 100 } as Touch], cancelable: true }))
    area.dispatchEvent(new TouchEvent('touchend', { touches: [], cancelable: true }))
  })
}

beforeEach(() => {
  installFakeBridge()
  useNodeStore.setState({ nodes: { [SURFACE]: terminal } })
  useSummaryChatStore.setState({ targetNodeId: null })
})

afterEach(() => {
  cleanup()
  act(() => useSurfacePresenterStore.getState().publishFocusedTerminal(null))
})

describe('the phone’s terminal view and composer', () => {
  // The composer, the terminal view and the talk button are keyed by the same
  // surface. With a bare node id as each key, opening the composer orphaned the
  // terminal view: its picture and touch handlers outlived closing it.
  it('leaves exactly one terminal view through the composer, and none once it closes', () => {
    // Summary Chat on the same surface keys the talk button by it too.
    useSummaryChatStore.setState({ targetNodeId: SURFACE })
    const { container } = render(<MobileApp Canvas={() => null} />)
    const views = () => container.querySelectorAll('.mobile-term').length
    act(() => useSurfacePresenterStore.getState().publishFocusedTerminal(SURFACE))
    expect(views()).toBe(1)

    tap(container.querySelector('.mobile-term__area')!)
    expect(container.querySelector('.mobile-composer')).not.toBeNull()
    expect(views()).toBe(1)

    fireEvent.click(container.querySelector('.mobile-btn--back')!)
    expect(container.querySelector('.mobile-composer')).toBeNull()
    expect(views()).toBe(1)

    act(() => useSurfacePresenterStore.getState().publishFocusedTerminal(null))
    expect(views()).toBe(0)
  })
})

describe('the phone’s bottom bar', () => {
  it('opens the surface list from the rocket and closes it again', () => {
    const { getByRole } = render(<MobileApp Canvas={() => null} />)
    fireEvent.click(getByRole('button', { name: 'Toolbar and surfaces' }))
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(true)
    fireEvent.click(getByRole('button', { name: 'Back to the canvas' }))
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(false)
  })

  it('never shows over a terminal, even with a conversation open', () => {
    useSummaryChatStore.setState({ targetNodeId: SURFACE })
    const { container } = render(<MobileApp Canvas={() => null} />)
    expect(container.querySelector('.m-bar')).not.toBeNull()
    act(() => useSurfacePresenterStore.getState().publishFocusedTerminal(SURFACE))
    expect(container.querySelector('.m-bar')).toBeNull()
  })
})
