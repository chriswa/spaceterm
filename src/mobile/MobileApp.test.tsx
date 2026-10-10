import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { installFakeBridge } from '@/testing/fake-bridge'
import { useNodeStore } from '@/stores/nodeStore'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useSummaryChatStore } from '@/stores/summaryChatStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { useReceptionistStore } from '@/stores/receptionistStore'
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
  act(() => useSurfacePresenterStore.getState().setToolbarSheetOpen(false))
  act(() => useControlTranscriptStore.getState().setOpen(false))
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

  it('stays up over the terminal view, and goes for the composer, which has its own microphone', () => {
    useSummaryChatStore.setState({ targetNodeId: SURFACE })
    const { container } = render(<MobileApp Canvas={() => null} />)
    expect(container.querySelector('.m-bar')).not.toBeNull()
    act(() => useSurfacePresenterStore.getState().publishFocusedTerminal(SURFACE))
    expect(container.querySelector('.m-bar')).not.toBeNull()

    tap(container.querySelector('.mobile-term__area')!)
    expect(container.querySelector('.mobile-composer')).not.toBeNull()
    expect(container.querySelector('.m-bar')).toBeNull()

    fireEvent.click(container.querySelector('.mobile-btn--back')!)
    expect(container.querySelector('.m-bar')).not.toBeNull()
  })
})

describe('the phone’s Control transcript', () => {
  beforeEach(() => {
    useReceptionistStore.setState({ phase: 'ready', target: false, error: null, holder: null })
  })

  it('opens on a tap of the Control button with the bar still up, the button a down arrow that closes it, and the microphone there', () => {
    const { container, getByRole } = render(<MobileApp Canvas={() => null} />)
    fireEvent.click(getByRole('button', { name: /^Control transcript/ }))
    expect(container.querySelector('.control-transcript--screen')).not.toBeNull()
    expect(container.querySelector('.m-bar')).not.toBeNull()
    // No conversation open, yet the microphone is up, and talks to Control.
    expect(getByRole('button', { name: /^Talk to Control/ })).toBeTruthy()

    fireEvent.click(getByRole('button', { name: 'Close the Control transcript' }))
    expect(container.querySelector('.control-transcript')).toBeNull()
  })

  it('swaps with the surface list rather than stacking on it, either way round', () => {
    const { container, getByRole } = render(<MobileApp Canvas={() => null} />)
    fireEvent.click(getByRole('button', { name: 'Toolbar and surfaces' }))
    fireEvent.click(getByRole('button', { name: /^Control transcript/ }))
    expect(useControlTranscriptStore.getState().open).toBe(true)
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Toolbar and surfaces' }))
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(true)
    expect(useControlTranscriptStore.getState().open).toBe(false)
    expect(container.querySelector('.control-transcript')).toBeNull()
  })
})
