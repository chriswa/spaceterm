import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'
import { ControlBacklogBadge, backlogBadgeText, backlogItemAge } from './ControlBacklogBadge'
import { useReceptionistStore } from '../stores/receptionistStore'
import type { ReceptionistBacklogEntry } from '../../../../shared/protocol'

afterEach(cleanup)

const setBacklog = (items: ReceptionistBacklogEntry[], count = items.length) =>
  act(() => useReceptionistStore.getState().setBacklog({ count, held: false, items }))

const LEON = { text: 'Leon finished the go-quiet follow-up.', addedAt: Date.now() - 5 * 60_000 }
const DEAN = { text: 'Dean asked two questions.', addedAt: Date.now() }

describe('backlogBadgeText', () => {
  it('says nothing when the backlog is empty', () => {
    expect(backlogBadgeText(0)).toBeNull()
  })

  it('counts the items, singular for one', () => {
    expect(backlogBadgeText(1)).toBe('1 backlog item')
    expect(backlogBadgeText(7)).toBe('7 backlog items')
  })
})

describe('backlogItemAge', () => {
  it('says how long an item has waited', () => {
    expect(backlogItemAge(0, 30_000)).toBe('just now')
    expect(backlogItemAge(0, 5 * 60_000)).toBe('5m ago')
    expect(backlogItemAge(0, 3 * 3_600_000)).toBe('3h ago')
    expect(backlogItemAge(0, 2 * 86_400_000)).toBe('2d ago')
  })
})

describe('ControlBacklogBadge', () => {
  const badge = () => screen.queryByRole('button', { name: /backlog/ })
  const list = () => screen.queryByRole('list', { name: 'Backlog' })

  it('follows the count as the server sends it', () => {
    setBacklog([])
    render(<ControlBacklogBadge />)
    expect(badge()).toBeNull()
    setBacklog([LEON, DEAN])
    expect(badge()?.textContent).toContain('2 backlog items')
    setBacklog([])
    expect(badge()).toBeNull()
  })

  it('opens the list of items, oldest first, and closes it again', () => {
    setBacklog([LEON, DEAN])
    render(<ControlBacklogBadge />)
    expect(list()).toBeNull()
    fireEvent.click(badge()!)
    expect(badge()?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `${LEON.text} · 5m ago`,
      `${DEAN.text} · just now`,
    ])
    fireEvent.click(badge()!)
    expect(badge()?.getAttribute('aria-expanded')).toBe('false')
    expect(list()).toBeNull()
  })

  it('keeps the open list up to date as items come and go', () => {
    setBacklog([LEON])
    render(<ControlBacklogBadge />)
    fireEvent.click(badge()!)
    setBacklog([LEON, DEAN])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    setBacklog([DEAN])
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${DEAN.text} · just now`])
  })

  it('closes with the badge when the last item goes, and comes back closed', () => {
    setBacklog([LEON])
    render(<ControlBacklogBadge />)
    fireEvent.click(badge()!)
    expect(list()).not.toBeNull()
    setBacklog([])
    expect(badge()).toBeNull()
    expect(list()).toBeNull()
    setBacklog([DEAN])
    expect(badge()?.getAttribute('aria-expanded')).toBe('false')
    expect(list()).toBeNull()
  })

  it('only counts when the server does not list its items', () => {
    setBacklog([], 3)
    render(<ControlBacklogBadge />)
    expect(badge()).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('3 backlog items')
  })
})
