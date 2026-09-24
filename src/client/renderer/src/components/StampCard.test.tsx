import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { installFakeBridge } from '../testing/fake-bridge'
import { StampCard } from './StampCard'
import { asNodeId } from '../../../../shared/ids'

/**
 * A stamp sits above every card, so the one thing it must not do is catch
 * clicks aimed at what is underneath. jsdom does no hit testing, so this pins
 * the contract the stylesheet enforces from: the shell opts out of the pointer
 * and only the painted glyph opts back in.
 */

const id = asNodeId('stamp-1')

function renderStamp(focused = false) {
  const onFocus = vi.fn()
  const onMove = vi.fn()
  const utils = render(
    <StampCard
      id={id}
      x={0}
      y={0}
      zIndex={1}
      stamp="star"
      focused={focused}
      selected={false}
      archivedChildren={[]}
      onFocus={onFocus}
      onClose={vi.fn()}
      onMove={onMove}
      onOpenArchiveSearch={vi.fn()}
      cameraRef={{ current: { x: 0, y: 0, z: 1 } }}
    />
  )
  return { ...utils, onFocus, onMove }
}

beforeEach(() => { installFakeBridge(globalThis as never) })
afterEach(cleanup)

describe('StampCard', () => {
  it('takes the pointer only on its painted glyph', () => {
    const { container } = renderStamp()
    const shell = container.querySelector(`[data-node-id="${id}"]`)!
    expect(shell.classList.contains('card-shell--painted-hit')).toBe(true)
    expect(container.querySelectorAll('.stamp-art__ink').length).toBeGreaterThan(0)
  })

  it('focuses on a click on the glyph and drags from it', () => {
    const { container, onFocus, onMove } = renderStamp()
    const ink = container.querySelector('.stamp-art__ink')!

    fireEvent.mouseDown(ink, { clientX: 0, clientY: 0 })
    fireEvent.mouseUp(window)
    expect(onFocus).toHaveBeenCalledWith(id)

    fireEvent.mouseDown(ink, { clientX: 0, clientY: 0 })
    fireEvent.mouseMove(window, { clientX: 40, clientY: 0 })
    fireEvent.mouseUp(window)
    expect(onMove).toHaveBeenLastCalledWith(id, 40, 0, false, false)
  })

  it('offers delete but no add-child or colour, being a leaf with a fixed colour', () => {
    const { container } = renderStamp(true)
    expect(container.querySelector('.node-titlebar__close')).not.toBeNull()
    expect(container.querySelector('.node-titlebar__add-btn')).toBeNull()
    expect(container.querySelector('.node-titlebar__color-btn')).toBeNull()
  })
})
