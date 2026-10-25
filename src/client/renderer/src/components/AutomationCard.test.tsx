import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { useScriptsSocketPathStore } from '../stores/scriptsSocketPathStore'
import { installFakeBridge } from '../testing/fake-bridge'
import { AutomationCard } from './AutomationCard'
import { useNodeStore } from '../stores/nodeStore'
import { asNodeId } from '../../../../shared/ids'
import type { AutomationOverlap } from '../../../../shared/automation'
import type { AutomationRunStats } from '../../../../shared/state'

const triggerInput = () => document.querySelector('.automation-card__trigger') as HTMLInputElement
const kindSelect = () => screen.getByLabelText('Trigger kind') as HTMLSelectElement
const overlapSelect = () => document.querySelector('.automation-card__overlap') as HTMLSelectElement

const id = asNodeId('auto-1')

function renderCard(props: { trigger?: string; prompt?: string; overlap?: AutomationOverlap; queued?: number; runStats?: AutomationRunStats } = {}) {
  const handlers = { onTriggerChange: vi.fn(), onPromptChange: vi.fn(), onOverlapChange: vi.fn(), onClearQueue: vi.fn(), onFocus: vi.fn(), onMove: vi.fn() }
  render(
    <AutomationCard
      id={id} x={0} y={0} zIndex={1} zoom={1} focused selected={false} archivedChildren={[]}
      trigger={props.trigger ?? ''} prompt={props.prompt ?? ''} overlap={props.overlap ?? 'single'} queued={props.queued ?? 0} runStats={props.runStats}
      onClose={vi.fn()} onColorChange={vi.fn()} onOpenArchiveSearch={vi.fn()}
      cameraRef={{ current: { x: 0, y: 0, z: 1 } }}
      {...handlers}
    />
  )
  return handlers
}

beforeEach(() => {
  installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
  useScriptsSocketPathStore.getState().set(undefined)
})

afterEach(cleanup)

describe('AutomationCard', () => {
  it('saves the trigger on Enter, trimmed', () => {
    const { onTriggerChange } = renderCard()
    const input = triggerInput()
    fireEvent.change(input, { target: { value: '  custom_linear ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onTriggerChange).toHaveBeenCalledWith(id, 'custom_linear')
  })

  it('does not save when the trigger did not change', () => {
    const { onTriggerChange } = renderCard({ trigger: 'custom_x' })
    fireEvent.blur(triggerInput())
    expect(onTriggerChange).not.toHaveBeenCalled()
  })

  it('says what is wrong with an invalid cron as you type, briefly, with the parser detail in the tooltip', () => {
    renderCard()
    fireEvent.change(triggerInput(), { target: { value: 'every morning' } })
    const status = document.querySelector('.automation-card__status--error') as HTMLElement
    expect(status.textContent).toContain('Five fields')
    expect(status.title).toContain('every morning')
  })

  it('reads a saved event id as a custom event', () => {
    renderCard({ trigger: 'custom_x' })
    expect(kindSelect().value).toBe('event')
  })

  it('names the socket an event arrives on, as the server reports it', () => {
    useScriptsSocketPathStore.getState().set('/srv/home/scripts.sock')
    renderCard({ trigger: 'custom_x' })
    expect(document.querySelector('.automation-card__status')?.textContent).toBe('Runs when custom_x is sent to socket:\n/srv/home/scripts.sock')
  })

  it('asks for the custom_ prefix rather than reading an event id as cron', () => {
    renderCard()
    fireEvent.change(kindSelect(), { target: { value: 'event' } })
    fireEvent.change(triggerInput(), { target: { value: 'initial_test' } })
    expect(document.querySelector('.automation-card__status--error')?.textContent).toContain('start with custom_')
  })

  it('points an event id typed as cron at the dropdown', () => {
    renderCard()
    fireEvent.change(triggerInput(), { target: { value: 'custom_x' } })
    expect(document.querySelector('.automation-card__status--error')?.textContent).toContain('Custom event')
  })

  it('shows the last run and the totals', () => {
    const startedAt = new Date(2026, 9, 24, 18, 2, 0).getTime()
    renderCard({ runStats: { runs: 12, totalCostUsd: 3.1, last: { costUsd: 0.42, tokens: 18_400, startedAt, endedAt: startedAt + 59_000 } } })
    expect(screen.getByText('Last run $0.42 · 18k tokens')).toBeTruthy()
    expect(screen.getByText(/→ .* · 59s$/)).toBeTruthy()
    expect(screen.getByText('Total $3.10 · 12 runs')).toBeTruthy()
  })

  it('says a cron trigger in English, and when it next runs', () => {
    renderCard({ trigger: '0 9 * * 1-5' })
    expect(document.querySelector('.automation-card__status')?.textContent).toBe('At 09:00 AM, Monday through Friday')
    // On the row it shares with the crontab.guru link.
    expect(document.querySelector('.automation-card__status-row .automation-card__next-run')?.textContent).toMatch(/^Next run/)
  })

  it('opens crontab.guru on the expression being edited, only for a cron trigger', () => {
    const bridge = installFakeBridge(globalThis as never)
    renderCard({ trigger: '*/15 * * * *' })
    fireEvent.click(screen.getByRole('button', { name: /crontab\.guru/ }))
    expect(bridge.calls.some((c) => c.method === 'openExternal' && c.args[0] === 'https://crontab.guru/#*/15_*_*_*_*')).toBe(true)
  })

  it('offers no cron help for an event trigger', () => {
    renderCard({ trigger: 'custom_x' })
    expect(screen.queryByRole('button', { name: /crontab\.guru/ })).toBeNull()
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

  it('focuses the card from a click on the gear behind it, and drags it from there', () => {
    const { onFocus, onMove } = renderCard()
    const gear = document.querySelector('.automation-gear-backdrop') as HTMLElement
    fireEvent.mouseDown(gear, { clientX: 0, clientY: 0 })
    fireEvent.mouseUp(window)
    expect(onFocus).toHaveBeenCalledWith(id)

    fireEvent.mouseDown(gear, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 40, clientY: 30 })
    fireEvent.mouseUp(window)
    expect(onMove).toHaveBeenCalledWith(id, 40, 30, false, false)
  })

  it('saves the prompt on blur exactly as typed, newlines and all', () => {
    const { onPromptChange } = renderCard({ prompt: 'old' })
    const box = screen.getByLabelText('Prompt')
    fireEvent.change(box, { target: { value: 'Check Linear.\n\n  Then report.' } })
    fireEvent.blur(box)
    expect(onPromptChange).toHaveBeenCalledWith(id, 'Check Linear.\n\n  Then report.')
  })

  it('throws away an unsaved prompt edit on Escape', () => {
    const { onPromptChange } = renderCard({ prompt: 'old' })
    const box = screen.getByLabelText('Prompt') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: 'new' } })
    fireEvent.keyDown(box, { key: 'Escape' })
    fireEvent.blur(box)
    expect(box.value).toBe('old')
    expect(onPromptChange).not.toHaveBeenCalled()
  })
})
