import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useRef } from 'react'
import { useEdgeHover, type HoveredEdge } from './useEdgeHover'
import type { Camera } from '../lib/camera'
import type { TreeLineNode } from '../components/CanvasBackground'
import { asNodeId } from '../../../../shared/ids'

/** One long edge from the root out to (2000, 0), well clear of the root node. */
const EDGES: TreeLineNode[] = [{ id: asNodeId('child'), parentId: asNodeId('root'), x: 2000, y: 0, freshness: 1 }]

let latest: HoveredEdge | null = null

function Harness() {
  const cameraRef = useRef<Camera>({ x: 0, y: 0, z: 1 })
  const edgesRef = useRef(EDGES)
  latest = useEdgeHover(cameraRef, edgesRef, false).hoveredEdge
  return null
}

/** A pointer event of a given kind; jsdom has no PointerEvent constructor. */
function pointer(el: Element, type: string, pointerType: string, x: number, y: number): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true })
  Object.defineProperty(ev, 'pointerType', { value: pointerType })
  el.dispatchEvent(ev)
}

let viewport: HTMLElement

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
  viewport = document.createElement('div')
  viewport.className = 'canvas-viewport'
  document.body.appendChild(viewport)
  latest = null
  render(<Harness />)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const frame = () => act(() => { vi.advanceTimersByTime(20) })

describe('useEdgeHover', () => {
  it('lights the edge under a mouse', () => {
    pointer(viewport, 'pointermove', 'mouse', 1000, 2)
    frame()
    expect(latest?.childId).toBe('child')
  })

  it('ignores a finger moving: a touch screen has no hover', () => {
    pointer(viewport, 'pointermove', 'touch', 1000, 2)
    frame()
    expect(latest).toBeNull()
  })

  it('ignores the mouse events a phone fakes for a tap', () => {
    // iOS fakes a mousemove at every tap and never takes it away; listening for
    // it left a phantom cursor, and a pan slid edges under it, lighting their
    // split dots.
    viewport.dispatchEvent(new MouseEvent('mousemove', { clientX: 1000, clientY: 2, bubbles: true }))
    frame()
    expect(latest).toBeNull()
  })

  it('forgets the mouse the moment a finger touches down', () => {
    pointer(viewport, 'pointermove', 'mouse', 1000, 2)
    frame()
    expect(latest).not.toBeNull()
    pointer(viewport, 'pointerdown', 'touch', 50, 300)
    frame()
    expect(latest).toBeNull()
  })
})
