import { useCallback, useRef, useState, createElement } from 'react'
import type { ReactNode, RefObject } from 'react'
import { screenToCanvas } from '../lib/camera'
import type { Camera } from '../lib/camera'
import { useNodeStore, nodePixelSize } from '../stores/nodeStore'
import { angleBorderColor } from '../lib/angle-color'
import { useRtsSelectStore } from '../stores/rtsSelectStore'

const CARD_SELECTOR = '.terminal-card, .markdown-card, .directory-card, .file-card, .title-card'

function findCardElement(nodeId: string): HTMLElement | null {
  const wrapper = document.querySelector(`[data-node-id="${nodeId}"]`)
  if (!wrapper) return null
  return wrapper.querySelector(CARD_SELECTOR) as HTMLElement | null
}

export function useRtsSelect(
  cameraRef: RefObject<Camera>,
  onComplete: (nodeIds: string[]) => void
): {
  startDrag: (e: MouseEvent) => void
  overlayElement: ReactNode
  active: boolean
} {
  const [active, setActive] = useState(false)
  const anchorRef = useRef({ x: 0, y: 0 })
  const currentRef = useRef({ x: 0, y: 0 })
  const rectRef = useRef<HTMLDivElement>(null)
  const selectedIdsRef = useRef(new Set<string>())
  const glowedElementsRef = useRef(new Map<string, HTMLElement>())
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const applyGlow = useCallback((el: HTMLElement, worldX: number, worldY: number) => {
    const color = angleBorderColor(worldX, worldY)
    const z = cameraRef.current?.z ?? 1
    const s = Math.max(1, 1 / z)
    const blur = 16 * s
    const spread = 4 * s
    el.style.boxShadow = `0 0 ${blur}px ${spread}px ${color}`
    el.style.borderColor = color
  }, [cameraRef])

  const clearGlow = useCallback((el: HTMLElement) => {
    el.style.boxShadow = ''
    el.style.borderColor = ''
  }, [])

  const updateRect = useCallback(() => {
    const el = rectRef.current
    if (!el) return

    const x1 = anchorRef.current.x
    const y1 = anchorRef.current.y
    const x2 = currentRef.current.x
    const y2 = currentRef.current.y

    const left = Math.min(x1, x2)
    const top = Math.min(y1, y2)
    const w = Math.abs(x2 - x1)
    const h = Math.abs(y2 - y1)

    const cam = cameraRef.current
    if (!cam) return
    const worldCenter = screenToCanvas({ x: left + w / 2, y: top + h / 2 }, cam)
    const color = angleBorderColor(worldCenter.x, worldCenter.y)

    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    el.style.borderColor = color
  }, [cameraRef])

  const hitTest = useCallback(() => {
    const cam = cameraRef.current
    if (!cam) return

    const x1 = anchorRef.current.x
    const y1 = anchorRef.current.y
    const x2 = currentRef.current.x
    const y2 = currentRef.current.y

    const topLeft = screenToCanvas({ x: Math.min(x1, x2), y: Math.min(y1, y2) }, cam)
    const bottomRight = screenToCanvas({ x: Math.max(x1, x2), y: Math.max(y1, y2) }, cam)

    const nodeList = useNodeStore.getState().nodeList
    const nodes = useNodeStore.getState().nodes
    const newIds = new Set<string>()

    for (const node of nodeList) {
      const size = nodePixelSize(node)
      const halfW = size.width / 2
      const halfH = size.height / 2

      if (
        node.x + halfW > topLeft.x &&
        node.x - halfW < bottomRight.x &&
        node.y + halfH > topLeft.y &&
        node.y - halfH < bottomRight.y
      ) {
        newIds.add(node.id)
      }
    }

    // Remove glow from nodes no longer selected
    glowedElementsRef.current.forEach((el, id) => {
      if (!newIds.has(id)) {
        clearGlow(el)
        glowedElementsRef.current.delete(id)
      }
    })

    // Add glow to newly selected nodes
    newIds.forEach(id => {
      if (!glowedElementsRef.current.has(id)) {
        const el = findCardElement(id)
        if (el) {
          const node = nodes[id]
          if (node) {
            applyGlow(el, node.x, node.y)
            glowedElementsRef.current.set(id, el)
          }
        }
      }
    })

    selectedIdsRef.current = newIds
  }, [cameraRef, applyGlow, clearGlow])

  const cleanup = useCallback(() => {
    glowedElementsRef.current.forEach(el => {
      clearGlow(el)
    })
    glowedElementsRef.current.clear()
    selectedIdsRef.current = new Set()
    setActive(false)
    document.querySelector('.canvas-viewport')?.classList.remove('rts-selecting')
  }, [clearGlow])

  const startDrag = useCallback((e: MouseEvent) => {
    anchorRef.current = { x: e.clientX, y: e.clientY }
    currentRef.current = { x: e.clientX, y: e.clientY }
    setActive(true)
    useRtsSelectStore.getState().start()
    document.querySelector('.canvas-viewport')?.classList.add('rts-selecting')

    function onMouseMove(ev: MouseEvent) {
      currentRef.current = { x: ev.clientX, y: ev.clientY }
      updateRect()
      hitTest()
    }

    function removeListeners() {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keyup', onKeyUp)
    }

    function onMouseUp() {
      removeListeners()
      const finalIds = Array.from(selectedIdsRef.current)
      cleanup()
      useRtsSelectStore.getState().finish()

      if (finalIds.length > 0) {
        onCompleteRef.current(finalIds)
      }
    }

    function onKeyUp(ev: KeyboardEvent) {
      if (ev.key === 'Shift') {
        removeListeners()
        cleanup()
        useRtsSelectStore.getState().cancel()
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keyup', onKeyUp)
  }, [updateRect, hitTest, cleanup])

  const overlayElement = active
    ? createElement('div', {
        ref: rectRef,
        className: 'rts-select-overlay',
        style: {
          position: 'absolute' as const,
          pointerEvents: 'none' as const,
          border: '1px solid',
          zIndex: 999999,
        },
      })
    : null

  return { startDrag, overlayElement, active }
}
