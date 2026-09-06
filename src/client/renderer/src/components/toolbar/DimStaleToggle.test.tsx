import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { DimStaleToggle } from './buttons'
import { useDimStaleStore } from '../../stores/dimStaleStore'
import { DEFAULT_STALE_THRESHOLD_HOURS } from '../../lib/dim-stale'

/**
 * A split control: the icon toggles the lens in one click, the caret pulls up
 * the threshold. The pairing is the thing that can break — a caret that also
 * toggles, or a threshold pick that changes nothing on screen.
 */

beforeEach(() => {
  useDimStaleStore.setState({ enabled: false, thresholdHours: DEFAULT_STALE_THRESHOLD_HOURS })
})

afterEach(cleanup)

function renderToggle() {
  const { container } = render(<DimStaleToggle />)
  const [dim, caret] = Array.from(container.querySelectorAll('button'))
  return { container, dim, caret }
}

describe('DimStaleToggle', () => {
  it('toggles the lens from the icon without opening the menu', () => {
    const { container, dim } = renderToggle()
    fireEvent.click(dim)
    expect(useDimStaleStore.getState().enabled).toBe(true)
    expect(container.querySelector('.toolbar__menu')).toBeNull()
  })

  it('opens the threshold menu from the caret without toggling the lens', () => {
    const { container, caret } = renderToggle()
    fireEvent.click(caret)
    expect(useDimStaleStore.getState().enabled).toBe(false)
    expect(container.querySelector('.toolbar__menu')).not.toBeNull()
  })

  it('offers every hour up to the default, marking the current one', () => {
    const { container, caret } = renderToggle()
    fireEvent.click(caret)
    const menu = container.querySelector('.toolbar__menu')!
    const items = Array.from(menu.querySelectorAll('.toolbar__menu-item'))
    expect(items).toHaveLength(DEFAULT_STALE_THRESHOLD_HOURS)
    expect(items[0].textContent).toContain('1 hour')
    expect(items.at(-1)!.textContent).toContain(`${DEFAULT_STALE_THRESHOLD_HOURS} hours`)
    expect(items.at(-1)!.className).toContain('toolbar__menu-item--active')
  })

  it('turns the lens on when a threshold is picked, so the pick is visible', () => {
    const { container, caret } = renderToggle()
    fireEvent.click(caret)
    const menu = container.querySelector('.toolbar__menu')!
    fireEvent.click(within(menu as HTMLElement).getByText('3 hours'))
    expect(useDimStaleStore.getState().thresholdHours).toBe(3)
    expect(useDimStaleStore.getState().enabled).toBe(true)
  })

  it('leaves the menu open while picking, and does not re-toggle a lens already on', () => {
    useDimStaleStore.setState({ enabled: true })
    const { container, caret } = renderToggle()
    fireEvent.click(caret)
    const menu = () => container.querySelector('.toolbar__menu')! as HTMLElement
    fireEvent.click(within(menu()).getByText('2 hours'))
    fireEvent.click(within(menu()).getByText('5 hours'))
    expect(useDimStaleStore.getState().thresholdHours).toBe(5)
    expect(useDimStaleStore.getState().enabled).toBe(true)
  })
})
