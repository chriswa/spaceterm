import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { AutomationCard } from './AutomationCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId } from '../../../../shared/ids'
import type { AutomationOverlap } from '../../../../shared/automation'
import type { AutomationRunStats } from '../../../../shared/state'

const kindSelect = () => screen.getByLabelText('Trigger kind') as HTMLSelectElement
const overlapSelect = () => document.querySelector('.automation-card__overlap') as HTMLSelectElement

const id = asNodeId('auto-1')

function renderCard(props: { trigger?: string; overlap?: AutomationOverlap; queued?: number; runStats?: AutomationRunStats } = {}) {
  const handlers = { onTriggerChange: vi.fn(), onOverlapChange: vi.fn(), onClearQueue: vi.fn() }
  render(
    <AutomationCard
      id={id} x={0} y={0} zIndex={1} zoom={1} focused selected={false} archivedChildren={[]}
      trigger={props.trigger ?? ''} overlap={props.overlap ?? 'single'} queued={props.queued ?? 0} runStats={props.runStats}
      onFocus={vi.fn()} onClose={vi.fn()} onMove={vi.fn()} onColorChange={vi.fn()} onOpenArchiveSearch={vi.fn()}
      cameraRef={{ current: { x: 0, y: 0, z: 1 } }}
      {...handlers}
    />
  )
  return handlers
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
})

afterEach(cleanup)

describe('AutomationCard', () => {
  it('saves the trigger on Enter, trimmed', () => {
    const { onTriggerChange } = renderCard()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '  custom_linear ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onTriggerChange).toHaveBeenCalledWith(id, 'custom_linear')
  })

  it('does not save when the trigger did not change', () => {
    const { onTriggerChange } = renderCard({ trigger: 'custom_x' })
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onTriggerChange).not.toHaveBeenCalled()
  })

  it('says what is wrong with an invalid cron as you type, briefly, with the parser detail in the tooltip', () => {
    renderCard()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'every morning' } })
    const status = document.querySelector('.automation-card__status--error') as HTMLElement
    expect(status.textContent).toContain('Five fields')
    expect(status.title).toContain('every morning')
  })

  it('reads a saved event id as a custom event', () => {
    renderCard({ trigger: 'custom_x' })
    expect(kindSelect().value).toBe('event')
  })

  it('asks for the custom_ prefix rather than reading an event id as cron', () => {
    renderCard()
    fireEvent.change(kindSelect(), { target: { value: 'event' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'initial_test' } })
    expect(document.querySelector('.automation-card__status--error')?.textContent).toContain('start with custom_')
  })

  it('points an event id typed as cron at the dropdown', () => {
    renderCard()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'custom_x' } })
    expect(document.querySelector('.automation-card__status--error')?.textContent).toContain('Custom event')
  })

  it('shows the last run and the totals', () => {
    renderCard({ runStats: { runs: 12, totalCostUsd: 3.1, last: { costUsd: 0.42, tokens: 18_400, endedAt: 0 } } })
    expect(screen.getByText('Last run $0.42 · 18k tokens')).toBeTruthy()
    expect(screen.getByText('Total $3.10 · 12 runs')).toBeTruthy()
  })

  it('shows when a cron trigger next runs', () => {
    renderCard({ trigger: '0 9 * * *' })
    expect(screen.getByText(/^Next run/)).toBeTruthy()
  })

  it('changes the overlap mode', () => {
    const { onOverlapChange } = renderCard()
    fireEvent.change(overlapSelect(), { target: { value: 'queue' } })
    expect(onOverlapChange).toHaveBeenCalledWith(id, 'queue')
  })

  it('shows the queue and clears it', () => {
    const { onClearQueue } = renderCard({ overlap: 'queue', queued: 3 })
    expect(screen.getByText(/3 queued/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onClearQueue).toHaveBeenCalledWith(id)
  })

  it('hides the queue for a mode that never queues and has nothing waiting', () => {
    renderCard({ overlap: 'parallel', queued: 0 })
    expect(screen.queryByText(/queued/)).toBeNull()
  })
})
