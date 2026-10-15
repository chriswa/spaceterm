import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act } from '@testing-library/react'
import { ControlBacklogBadge, backlogBadgeText } from './ControlBacklogBadge'
import { useReceptionistStore } from '../stores/receptionistStore'

afterEach(cleanup)

describe('backlogBadgeText', () => {
  it('says nothing when the backlog is empty', () => {
    expect(backlogBadgeText(0)).toBeNull()
  })

  it('counts the items, singular for one', () => {
    expect(backlogBadgeText(1)).toBe('1 backlog item')
    expect(backlogBadgeText(7)).toBe('7 backlog items')
  })
})

describe('ControlBacklogBadge', () => {
  it('follows the count as the server sends it', () => {
    act(() => useReceptionistStore.getState().setBacklog(0))
    render(<ControlBacklogBadge />)
    expect(screen.queryByRole('status')).toBeNull()
    act(() => useReceptionistStore.getState().setBacklog(2))
    expect(screen.getByRole('status').textContent).toBe('2 backlog items')
    act(() => useReceptionistStore.getState().setBacklog(0))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
