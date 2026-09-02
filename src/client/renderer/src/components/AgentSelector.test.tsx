import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { AgentSelector, AGENT_SELECTOR_OPTIONS } from './AgentSelector'

afterEach(cleanup)

describe('AgentSelector', () => {
  it('makes the keyboard launch order visible', () => {
    const { getAllByRole } = render(<AgentSelector onSelect={vi.fn()} onDismiss={vi.fn()} />)

    expect(AGENT_SELECTOR_OPTIONS.map(option => [option.key, option.type])).toEqual([
      ['1', 'claude'],
      ['2', 'codex'],
      ['3', 'cursor'],
    ])
    expect(getAllByRole('button').map(button => button.textContent)).toEqual([
      '1Claude Code',
      '2Codex',
      '3Cursor Agent',
    ])
  })

  it('launches the clicked agent and dismisses only clicks outside itself', () => {
    const onSelect = vi.fn()
    const onDismiss = vi.fn()
    const { getByRole } = render(<AgentSelector onSelect={onSelect} onDismiss={onDismiss} />)

    fireEvent.mouseDown(getByRole('button', { name: '2Codex' }))
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.click(getByRole('button', { name: '2Codex' }))
    expect(onSelect).toHaveBeenCalledWith('codex')

    fireEvent.mouseDown(document.body)
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
