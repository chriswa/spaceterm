import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { NotificationRecord } from '../../../../../shared/notifications'
import { asNodeId } from '../../../../../shared/ids'
import type { NodeData } from '../../../../../shared/state'
import { NotificationsButton } from './NotificationsButton'
import { installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'
import { useNodeStore } from '../../stores/nodeStore'
import { useSurfacePresenterStore } from '../../stores/surfacePresenterStore'

function sent(seq: number, overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return { seq, at: Date.now(), nodeId: asNodeId(`n${seq}`), kind: 'question', title: `Agent ${seq}`, body: 'It asks', reached: true, ...overrides }
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
})

afterEach(cleanup)

async function open(list: NotificationRecord[]) {
  bridge.responses.notifications = list
  const utils = render(<NotificationsButton />)
  fireEvent.click(utils.getByLabelText('Notifications'))
  await act(async () => {})
  const rows = () => Array.from(utils.container.querySelectorAll<HTMLElement>('.event-log__row'))
  return { ...utils, rows }
}

describe('NotificationsButton', () => {
  it('asks for nothing until it is opened', () => {
    render(<NotificationsButton />)
    expect(bridge.callsTo('node.notifications')).toEqual([])
  })

  it('lists each with its kind and surface, newest first', async () => {
    const { rows } = await open([
      sent(1, { kind: 'permission', title: 'Fix the build' }),
      sent(2, { kind: 'plan' }),
      sent(3, { kind: 'manual', title: 'Deploy', reached: false }),
    ])
    const text = rows().map((r) => r.textContent)
    expect(text[0]).toContain('Manual')
    expect(text[0]).toContain('Deploy')
    expect(text[0]).toContain('not delivered')
    expect(text[1]).toContain('Plan')
    expect(text[2]).toContain('Permission')
    expect(text[2]).toContain('Fix the build')
    expect(text[2]).not.toContain('not delivered')
  })

  it('goes to the surface when a row is clicked, and closes', async () => {
    useNodeStore.setState({ nodes: { n1: { id: 'n1', type: 'terminal' } as unknown as NodeData } })
    const { rows, container } = await open([sent(1)])
    fireEvent.click(rows()[0])
    expect(useSurfacePresenterStore.getState().focusRequest?.nodeId).toBe('n1')
    expect(container.querySelector('.toolbar__menu')).toBeNull()
  })

  it('adds new ones live while open, once each', async () => {
    const { rows } = await open([sent(1)])
    act(() => bridge.emit.notificationSent(sent(2)))
    act(() => bridge.emit.notificationSent(sent(2)))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0].textContent).toContain('Agent 2')
  })

  it('says so when there are none', async () => {
    const { container } = await open([])
    expect(container.querySelector('.event-log__empty')?.textContent).toContain('None sent yet')
  })
})
