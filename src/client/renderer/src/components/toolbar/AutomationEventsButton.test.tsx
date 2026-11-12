import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { AutomationEventRecord } from '../../../../../shared/automation'
import { AutomationEventsButton } from './AutomationEventsButton'
import { installFakeBridge, type FakeBridge } from '../../testing/fake-bridge'

function event(seq: number, overrides: Partial<AutomationEventRecord> = {}): AutomationEventRecord {
  return { seq, at: Date.now(), eventId: `custom_${seq}`, outcome: { kind: 'fired', matched: 1 }, ...overrides }
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
})

afterEach(cleanup)

async function open(events: AutomationEventRecord[]) {
  bridge.responses.automationEvents = events
  const utils = render(<AutomationEventsButton />)
  fireEvent.click(utils.getByLabelText('Automation events'))
  await act(async () => {})
  const rows = () => Array.from(utils.container.querySelectorAll<HTMLElement>('.event-log__row'))
  return { ...utils, rows }
}

describe('AutomationEventsButton', () => {
  it('asks for nothing until it is opened', () => {
    render(<AutomationEventsButton />)
    expect(bridge.callsTo('node.automationEvents')).toEqual([])
  })

  it('says what became of each event, newest first', async () => {
    const { rows } = await open([
      event(1),
      event(2, { outcome: { kind: 'fired', matched: 3 } }),
      event(3, { eventId: 'custom_typo', outcome: { kind: 'unheard', disabled: 0 } }),
      event(4, { outcome: { kind: 'unheard', disabled: 1 } }),
      event(5, { eventId: 'linear', outcome: { kind: 'rejected', error: 'event ids look like custom_name' } })
    ])
    const text = rows().map((r) => r.textContent)
    expect(text[0]).toContain('linear')
    expect(text[0]).toContain('rejected')
    expect(text[0]).toContain('event ids look like custom_name')
    expect(text[1]).toContain('1 card, switched off')
    expect(text[2]).toContain('custom_typo')
    expect(text[2]).toContain('no card listening')
    expect(text[3]).toContain('3 cards')
    expect(text[4]).toContain('1 card')
  })

  it('shows the payload on one line, and in full when the row is opened', async () => {
    const { rows, container } = await open([event(1, { payload: { ticket: 'ENG-1' } })])
    expect(rows()[0].querySelector('.event-log__summary')?.textContent).toBe('{"ticket":"ENG-1"}')
    expect(container.querySelector('.event-log__payload')).toBeNull()

    fireEvent.click(rows()[0])
    expect(container.querySelector('.event-log__payload')?.textContent).toBe('{\n  "ticket": "ENG-1"\n}')
    expect(rows()[0].querySelector('.event-log__summary')).toBeNull()

    // Clicking inside the payload, as selecting text does, leaves it open.
    fireEvent.click(container.querySelector('.event-log__payload')!)
    expect(container.querySelector('.event-log__payload')).not.toBeNull()
  })

  it('says when only the start of a payload was kept', async () => {
    const { rows, container } = await open([
      event(1, { oversizedPayload: { preview: '"xxx', bytes: 70_000 }, outcome: { kind: 'rejected', error: 'too big' } })
    ])
    fireEvent.click(rows()[0])
    expect(container.querySelector('.event-log__payload')?.textContent).toContain('70000 bytes')
  })

  it('adds events live while open, once each, and stops listening when closed', async () => {
    const { rows, getByLabelText } = await open([event(1)])
    act(() => bridge.emit.automationEvent(event(2)))
    act(() => bridge.emit.automationEvent(event(2)))
    await waitFor(() => expect(rows()).toHaveLength(2))
    expect(rows()[0].textContent).toContain('custom_2')

    fireEvent.click(getByLabelText('Automation events'))
    expect(rows()).toEqual([])
    act(() => bridge.emit.automationEvent(event(3)))
    expect(rows()).toEqual([])
  })

  it('says how to send one when there are none', async () => {
    const { container } = await open([])
    expect(container.querySelector('.event-log__empty')?.textContent).toContain('spaceterm-cli fire')
  })
})
