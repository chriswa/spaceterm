import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import type { NodeData, TerminalNodeData } from '../../../../../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID } from '../../../../../shared/ids'
import { DebugDropdown } from './buttons'
import { TOOLBAR_WIDGETS } from './registry'
import { installFakeBridge } from '../../testing/fake-bridge'
import { useFramePolicyStore } from '../../stores/framePolicyStore'
import { useNodeStore } from '../../stores/nodeStore'
import { useRollingRestartStore } from '../../stores/rollingRestartStore'
import type { RollingRestartDeps } from '../../lib/rolling-restart'

/**
 * Background Frames and Rolling Restart used to be toolbar buttons of their
 * own. In the debug menu they must still do what they did and still show what
 * they showed — including a rolling restart's progress, which outlives the
 * menu that started it.
 */

function terminal(id: string, overrides: Partial<Record<string, unknown>> = {}): TerminalNodeData {
  return {
    type: 'terminal', id: asNodeId(id), parentId: ROOT_NODE_ID,
    x: 0, y: 0, zIndex: 1, sessionId: asPtySessionId(id), cols: 80, rows: 24, alive: true,
    claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: 0, terminalSessions: [], claudeSessionHistory: [],
    shellTitleHistory: [], archivedChildren: [], ...overrides
  } as unknown as TerminalNodeData
}

const realStart = useRollingRestartStore.getState().start

beforeEach(() => {
  installFakeBridge(globalThis as never)
  if (useFramePolicyStore.getState().unfocused === 'full') useFramePolicyStore.getState().toggle()
  useRollingRestartStore.setState({ progress: null, start: realStart })
  useNodeStore.setState({ nodes: {} as Record<string, NodeData> })
})

afterEach(cleanup)

function openMenu() {
  const utils = render(<DebugDropdown onDebugCapture={() => {}} onInertiaLogDump={() => {}} />)
  const bug = utils.container.querySelector('button')!
  fireEvent.click(bug)
  const item = (label: string) =>
    Array.from(utils.container.querySelectorAll<HTMLButtonElement>('.toolbar__menu-item'))
      .find((b) => b.textContent?.includes(label))!
  return { ...utils, bug, item }
}

describe('the toolbar', () => {
  it('no longer carries the two buttons the debug menu took over', () => {
    const ids = TOOLBAR_WIDGETS.map((w) => w.id)
    expect(ids).not.toContain('rolling-restart')
    expect(ids).not.toContain('unfocused-frames')
    expect(ids).toContain('restart')
  })
})

describe('Background Frames, in the debug menu', () => {
  it('toggles the frame policy, lights when full, and keeps the menu open', () => {
    const { container, item } = openMenu()
    expect(item('Background Frames').className).not.toContain('toolbar__menu-item--active')
    expect(item('Background Frames').textContent).toContain('reduced')

    fireEvent.click(item('Background Frames'))
    expect(useFramePolicyStore.getState().unfocused).toBe('full')
    expect(container.querySelector('.toolbar__menu')).not.toBeNull()
    expect(item('Background Frames').className).toContain('toolbar__menu-item--active')
    expect(item('Background Frames').textContent).toContain('full')
  })
})

describe('Rolling restart, in the debug menu', () => {
  it('names how many surfaces it will hit, and is disabled with none', () => {
    const { item, rerender } = openMenu()
    expect(item('agent surface').disabled).toBe(true)

    act(() => useNodeStore.setState({ nodes: {
      a: terminal('a', { agentType: 'claude' }),
      b: terminal('b', { agentType: 'claude' }),
      shell: terminal('shell'),
    } as Record<string, NodeData> }))
    rerender(<DebugDropdown onDebugCapture={() => {}} onInertiaLogDump={() => {}} />)
    expect(item('agent surface').textContent).toContain('Restart 2 agent surfaces')
    expect(item('agent surface').disabled).toBe(false)
  })

  it('starts on the live agent surfaces and closes the menu', () => {
    const start = vi.fn(async () => {})
    useRollingRestartStore.setState({ start })
    useNodeStore.setState({ nodes: { a: terminal('a', { agentType: 'claude' }) } as Record<string, NodeData> })
    const { container, item } = openMenu()

    fireEvent.click(item('Restart 1 agent surface'))
    expect(start).toHaveBeenCalledTimes(1)
    expect((start.mock.calls[0] as unknown as [TerminalNodeData[]])[0].map((n) => n.id)).toEqual(['a'])
    expect(container.querySelector('.toolbar__menu')).toBeNull()
  })

  it('shows its progress on the bug button while the menu is closed, then clears', async () => {
    let release!: () => void
    const deps: RollingRestartDeps = {
      restart: () => new Promise<void>((resolve) => { release = resolve }),
      wait: async () => {},
    }
    const { container } = render(<DebugDropdown onDebugCapture={() => {}} onInertiaLogDump={() => {}} />)
    const bug = container.querySelector('button')!

    let run!: Promise<void>
    act(() => { run = useRollingRestartStore.getState().start([terminal('a', { agentType: 'claude' })], deps) })
    expect(container.querySelector('.toolbar__menu')).toBeNull()
    expect(bug.className).toContain('toolbar__btn--active')
    expect(bug.dataset.tooltip).toBe('Debug tools — rolling restart 0/1')

    // A second run cannot start on top of the first.
    await act(() => useRollingRestartStore.getState().start([terminal('b', { agentType: 'claude' })], deps))
    expect(useRollingRestartStore.getState().progress).toEqual({ done: 0, total: 1 })

    await act(async () => { release(); await run })
    expect(bug.className).not.toContain('toolbar__btn--active')
    expect(bug.dataset.tooltip).toBe('Debug tools')
  })

  it('disables the item while a run is in flight', () => {
    useNodeStore.setState({ nodes: { a: terminal('a', { agentType: 'claude' }) } as Record<string, NodeData> })
    useRollingRestartStore.setState({ progress: { done: 1, total: 3 } })
    const { item } = openMenu()
    expect(item('Restarting').textContent).toContain('Restarting — 1/3')
    expect(item('Restarting').disabled).toBe(true)
  })
})
