import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { FloatingToolbar } from './FloatingToolbar'
import { nodeActionRegistry } from '../lib/action-registry'
import { DEFAULT_PRESET } from '../lib/color-presets'
import { asNodeId } from '../../../../shared/ids'

const id = asNodeId('n1')

function setup(openedByTouch: boolean) {
  const onFork = vi.fn()
  nodeActionRegistry.set(id, { nodeId: id, focused: false, onColorChange: vi.fn(), archivedChildren: [], onClose: vi.fn(), onFork })
  const view = render(
    <FloatingToolbar nodeId={id} screenX={100} screenY={100} preset={DEFAULT_PRESET} onDismiss={vi.fn()} openedByTouch={openedByTouch} />
  )
  const fork = view.container.querySelector('.node-titlebar__fork-btn') as HTMLElement
  return { onFork, fork }
}

afterEach(() => {
  cleanup()
  nodeActionRegistry.clear()
})

describe('FloatingToolbar', () => {
  it('opened by a long press, ignores the click made by lifting that finger', () => {
    const { onFork, fork } = setup(true)
    fireEvent.click(fork)
    expect(onFork).not.toHaveBeenCalled()
  })

  it('takes a click from a fresh tap after that', () => {
    const { onFork, fork } = setup(true)
    fireEvent.click(fork)
    fireEvent.touchStart(fork, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.click(fork)
    expect(onFork).toHaveBeenCalledTimes(1)
  })

  it('opened by the mouse, takes the first click', () => {
    const { onFork, fork } = setup(false)
    fireEvent.click(fork)
    expect(onFork).toHaveBeenCalledTimes(1)
  })
})
