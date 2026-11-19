import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { BrowserCard } from './BrowserCard'
import { useNodeStore } from '../stores/nodeStore'
import { useSurfacePresenterStore } from '../stores/surfacePresenterStore'
import { asNodeId } from '../../../../shared/ids'

const id = asNodeId('page')

function card(overrides: Partial<Parameters<typeof BrowserCard>[0]> = {}) {
  return (
    <BrowserCard
      id={id} x={0} y={0} zIndex={1} zoom={1}
      profile="chrome" url="https://example.com/" title="Example Domain" width={1000} height={500}
      focused={false} selected={false} archivedChildren={[]}
      onFocus={vi.fn()} onClose={vi.fn()} onMove={vi.fn()} onColorChange={vi.fn()} onOpenArchiveSearch={vi.fn()}
      cameraRef={{ current: { x: 0, y: 0, z: 1 } }}
      {...overrides}
    />
  )
}

let bridge: FakeBridge
const watches = () => bridge.calls.filter((c) => c.method === 'browser.watch').map((c) => c.args[1])
const inputs = () => bridge.calls.filter((c) => c.method === 'browser.input').map((c) => c.args[1])

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useNodeStore.setState({ nodes: {} })
  useSurfacePresenterStore.setState({ external: false })
})
afterEach(cleanup)

describe('BrowserCard', () => {
  it('watches a thumbnail unfocused, and the live page once focused', () => {
    const { rerender } = render(card())
    expect(watches().at(-1)).toEqual({ live: false, scale: 0.5 })
    rerender(card({ focused: true, zoom: 2 }))
    expect(watches().at(-1)).toMatchObject({ live: true })
  })

  it('stays a thumbnail when the host shows the focused page itself, as the phone does', () => {
    useSurfacePresenterStore.setState({ external: true })
    render(card({ focused: true }))
    expect(watches().every((w) => (w as { live: boolean }).live === false)).toBe(true)
  })

  it('says why there is no page', () => {
    render(card())
    act(() => bridge.emit.browserStatus(id, { kind: 'unavailable', reason: 'Turn on remote debugging in Chrome.' }))
    expect(screen.getByText('Turn on remote debugging in Chrome.')).toBeTruthy()
  })

  it('shows each frame, and sends a click on it to the page in its own pixels', async () => {
    const { container } = render(card({ focused: true }))
    await act(async () => {
      bridge.emit.browserFrame({ type: 'browser-frame', nodeId: id, data: 'AAAA', width: 1000, height: 500 })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const img = container.querySelector('.browser-card__frame') as HTMLImageElement
    expect(img.src).toBe('data:image/jpeg;base64,AAAA')
    // Drawn at half size: the card's page box is 500 × 250 on screen.
    img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 500, height: 250, right: 510, bottom: 270, x: 10, y: 20, toJSON: () => ({}) })
    fireEvent.mouseDown(container.querySelector('.browser-card__page')!, { clientX: 60, clientY: 45, button: 0, detail: 1 })
    expect(inputs()).toEqual([{ kind: 'mouse', type: 'mousePressed', x: 100, y: 50, button: 'left', clickCount: 1, modifiers: 0 }])
  })

  it('leaves the mouse and keys to the canvas while unfocused', () => {
    const { container } = render(card())
    fireEvent.mouseDown(container.querySelector('.browser-card__page')!, { clientX: 60, clientY: 45 })
    fireEvent.keyDown(container.querySelector('.browser-card__keys')!, { key: 'a' })
    expect(inputs()).toEqual([])
  })
})
