import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { AutomationCard } from './AutomationCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId } from '../../../../shared/ids'
import type { AutomationOverlap } from '../../../../shared/automation'

const id = asNodeId('auto-1')

function renderCard(props: { trigger?: string; overlap?: AutomationOverlap; queued?: number } = {}) {
  const handlers = { onTriggerChange: vi.fn(), onOverlapChange: vi.fn(), onClearQueue: vi.fn() }
  render(
    <AutomationCard
      id={id} x={0} y={0} zIndex={1} zoom={1} focused selected={false} archivedChildren={[]}
      trigger={props.trigger ?? ''} overlap={props.overlap ?? 'single'} queued={props.queued ?? 0}
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

  it('says what is wrong with an invalid trigger as you type', () => {
    renderCard()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'every morning' } })
    expect(document.querySelector('.automation-card__status--error')).not.toBeNull()
  })

  it('shows when a cron trigger next runs', () => {
    renderCard({ trigger: '0 9 * * *' })
    expect(screen.getByText(/^Next run/)).toBeTruthy()
  })

  it('changes the overlap mode', () => {
    const { onOverlapChange } = renderCard()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'queue' } })
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
