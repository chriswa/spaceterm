import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { EdgeSplitMenu } from './EdgeSplitMenu'

afterEach(cleanup)

function open(openedByTouch: boolean) {
  installFakeBridge()
  const onSelect = vi.fn()
  const view = render(<EdgeSplitMenu screenX={100} screenY={100} onSelect={onSelect} onDismiss={vi.fn()} openedByTouch={openedByTouch} />)
  const first = view.container.querySelector('.add-node-body__item') as HTMLElement
  return { onSelect, first }
}

describe('EdgeSplitMenu', () => {
  it('opened by a long press on an edge, the lifting finger picks nothing; the next tap does', () => {
    const { onSelect, first } = open(true)
    fireEvent.click(first)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.touchStart(first, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.click(first)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('opened by ⌘-click, takes the first click', () => {
    const { onSelect, first } = open(false)
    fireEvent.click(first)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})
