import { useRef, useEffect, useLayoutEffect, useState } from 'react'
import crabIcon from '../../assets/crab.png'
import cursorAgentIcon from '../../assets/cursor-agent.png'
import codexAgentIcon from '../../assets/codex-agent.png'
import terminalIcon from '../../assets/terminal.png'
import type { AgentIndicatorKind, CrabEntry } from '../../lib/crab-nav'
import { CrabDance } from '../../lib/crab-dance'
import { useHoveredCardStore } from '../../stores/hoveredCardStore'
import { useSpeakingStore } from '../../stores/speakingStore'
import { useSummaryChatStore } from '../../stores/summaryChatStore'
import { useSummaryBubble } from '../../mods/summary-chat/bubble-facet'
import { asNodeId, type NodeId } from '../../../../../shared/ids'

/**
 * The row of per-surface indicators at the right of the toolbar.
 *
 * MODDING.md lists this as one of the toolbar's unrelated tenants: it is
 * simultaneously a FLIP animation, a rAF dance loop, a drag-to-reorder
 * implementation and a nav-indicator state machine, and none of that has
 * anything to do with a toolbar. It is here so the toolbar itself can be read
 * in one screen.
 */

/** A crab-nav jump, used to animate the indicator triangle between surfaces. */
export type CrabNavEvent = { fromNodeId: string | null; toNodeId: string; ts: number } | null

function indicatorIconUrl(kind: AgentIndicatorKind): string {
  if (kind === 'terminal') return terminalIcon
  if (kind === 'cursor') return cursorAgentIcon
  if (kind === 'codex') return codexAgentIcon
  return crabIcon
}

function indicatorKindClass(kind: AgentIndicatorKind): string {
  if (kind === 'cursor') return ' toolbar__crab--cursor'
  if (kind === 'codex') return ' toolbar__crab--codex'
  return ''
}

export interface CrabGroupProps {
  crabs: CrabEntry[]
  onCrabClick: (nodeId: NodeId, metaKey: boolean) => void
  onCrabReorder: (order: NodeId[]) => void
  selectedNodeId: NodeId | null
  crabNavEvent: CrabNavEvent
}

export function CrabGroup({ crabs, onCrabClick, onCrabReorder, selectedNodeId, crabNavEvent }: CrabGroupProps) {
  const hoveredNodeId = useHoveredCardStore(s => s.hoveredNodeId)
  const speakingSessions = useSpeakingStore(s => s.speaking)
  const summaryTargetNodeId = useSummaryChatStore(s => s.targetNodeId)
  const summaryThinking = useSummaryChatStore(s => s.thinking)
  // Supplied by the summary-chat mod, not by the base theme system — the
  // active theme may swap it for a different mark entirely.
  const { Component: SummaryBubble } = useSummaryBubble()
  const containerRef = useRef<HTMLDivElement>(null)
  const prevCrabsRef = useRef<CrabEntry[]>([])
  const positionsRef = useRef<Map<string, number>>(new Map())
  const isFirstRenderRef = useRef(true)
  const isDraggingRef = useRef(false)
  const triangleRef = useRef<HTMLDivElement>(null)
  const navAnimRef = useRef<{ cancel: () => void } | null>(null)

  // Capture positions before paint, animate enter/exit/reorder.
  // Positions are stored as distance from the slot's left edge to the
  // container's right edge (offsetWidth - offsetLeft). The container's right
  // edge is viewport-anchored (toolbar is full-width, crabs are the rightmost
  // flex item), so this metric is stable: a crab that hasn't moved within the
  // group keeps the same value even when siblings are added/removed.
  //
  // IMPORTANT: We use offsetLeft/offsetWidth (layout positions) instead of
  // getBoundingClientRect() because the latter includes transforms from
  // in-progress Web Animations, which creates a feedback loop: animations
  // pollute measurements → bogus deltas → more animations.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const prevCrabs = prevCrabsRef.current
    const oldPositions = positionsRef.current
    const newPositions = new Map<string, number>()

    const slots = el.querySelectorAll<HTMLElement>('.toolbar__crab-slot')
    const containerWidth = el.offsetWidth
    for (const slot of slots) {
      const nodeId = slot.dataset.nodeId ? asNodeId(slot.dataset.nodeId) : undefined
      if (nodeId) {
        newPositions.set(nodeId, containerWidth - slot.offsetLeft)
      }
    }

    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      positionsRef.current = newPositions
      prevCrabsRef.current = crabs
      return
    }

    const prevIds = new Set(prevCrabs.map(c => c.nodeId))
    const currIds = new Set(crabs.map(c => c.nodeId))

    // Exits — crabs in prev but not current
    for (const prev of prevCrabs) {
      if (!currIds.has(prev.nodeId)) {
        const oldRightOffset = oldPositions.get(prev.nodeId)
        if (oldRightOffset == null) continue

        // Convert right-relative offset to left position within current container
        const phantomLeft = containerWidth - oldRightOffset
        const phantom = document.createElement('button')
        phantom.className = `toolbar__crab toolbar__crab--${prev.color}${indicatorKindClass(prev.kind)}`
        const maskUrl = indicatorIconUrl(prev.kind)
        const maskSize = prev.kind === 'codex' ? '97%' : prev.kind === 'cursor' ? '80%' : 'contain'
        const maskPosition = prev.kind === 'codex' ? 'center calc(50% - 1px)' : prev.kind === 'cursor' ? 'center calc(50% - 1px)' : 'center'
        phantom.style.cssText = `position:absolute;top:0;left:${phantomLeft}px;pointer-events:none;width:20px;height:20px;border:none;padding:0;-webkit-mask-image:url(${maskUrl});mask-image:url(${maskUrl});-webkit-mask-size:${maskSize};mask-size:${maskSize};-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:${maskPosition};mask-position:${maskPosition};`
        el.appendChild(phantom)

        const anim = phantom.animate(
          [
            { transform: 'translateY(0)', opacity: 1 },
            { transform: 'translateY(40px)', opacity: 0 },
          ],
          { duration: 250, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
        )
        anim.onfinish = () => phantom.remove()
      }
    }

    // Enters — crabs in current but not prev
    for (const slot of slots) {
      const nodeId = slot.dataset.nodeId ? asNodeId(slot.dataset.nodeId) : undefined
      if (nodeId && !prevIds.has(nodeId)) {
        slot.animate(
          [
            { transform: 'translateY(-40px)', opacity: 0 },
            { transform: 'translateY(0)', opacity: 1 },
          ],
          { duration: 280, easing: 'cubic-bezier(0.4, 0, 1, 1)' }
        )
      }
    }

    // FLIP reorder — crabs present in both.
    // Skip when a drag just caused the reorder — siblings were already visually
    // shifted during drag, so the FLIP animation would fight with those transforms.
    if (!isDraggingRef.current) {
      // delta = newRightOffset - oldRightOffset: positive means the crab moved
      // further from the right edge (leftward), so we start shifted right.
      for (const slot of slots) {
        const nodeId = slot.dataset.nodeId ? asNodeId(slot.dataset.nodeId) : undefined
        if (nodeId && prevIds.has(nodeId) && currIds.has(nodeId)) {
          const oldRightOffset = oldPositions.get(nodeId)
          const newRightOffset = newPositions.get(nodeId)
          if (oldRightOffset != null && newRightOffset != null) {
            const delta = newRightOffset - oldRightOffset
            if (Math.abs(delta) > 1) {
              slot.animate(
                [
                  { transform: `translateX(${delta}px)` },
                  { transform: 'translateX(0)' },
                ],
                { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
              )
            }
          }
        }
      }
    }

    positionsRef.current = newPositions
    prevCrabsRef.current = crabs
  }, [crabs])

  // Beat-synced glow/bounce/rock animation loop
  useEffect(() => {
    let rafId = 0
    const dance = new CrabDance()
    let logCounter = 0

    const tick = () => {
      rafId = requestAnimationFrame(tick)
      const el = containerRef.current
      if (!el) return

      const { glowPulse, rock, bounce } = dance.tick()
      const glowRadius = 2 + 4 * glowPulse

      // Target inner crab buttons, skipping exit phantoms
      const crabButtons = el.querySelectorAll<HTMLElement>('.toolbar__crab-slot .toolbar__crab')
      for (const child of crabButtons) {
        child.style.filter = `drop-shadow(0 0 ${glowRadius}px currentColor)`
        if (child.classList.contains('toolbar__crab--attention')) {
          child.style.translate = `0 ${-bounce}px`
          child.style.rotate = `${rock}deg`
        } else {
          child.style.translate = ''
          child.style.rotate = ''
        }
      }

      logCounter++
      if (logCounter % 120 === 0) {
        window.api.log(`[crab-dance] rock=${rock.toFixed(1)} bounce=${bounce.toFixed(1)}`)
      }
    }

    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const handleCrabMouseDown = (e: React.MouseEvent, crabIndex: number) => {
    if (e.button !== 0) return
    e.preventDefault()

    const container = containerRef.current
    if (!container) return

    const startX = e.clientX
    const metaKey = e.metaKey
    const nodeId = crabs[crabIndex].nodeId
    let dragging = false

    // Measure slot positions using layout (not getBoundingClientRect, which includes transforms)
    const slots = container.querySelectorAll<HTMLElement>('.toolbar__crab-slot')
    const slotCenters: number[] = []
    const containerRect = container.getBoundingClientRect()
    for (const slot of slots) {
      slotCenters.push(containerRect.left + slot.offsetLeft + slot.offsetWidth / 2)
    }

    const draggedSlot = slots[crabIndex]

    // Measure slot stride for sibling shifting
    const slotStride = slotCenters.length > 1
      ? slotCenters[1] - slotCenters[0]
      : 26

    let prevTargetIndex = crabIndex

    const computeTargetIndex = (dx: number) => {
      const draggedCenter = slotCenters[crabIndex] + dx
      let idx = 0
      for (let i = 0; i < slotCenters.length; i++) {
        if (slotCenters[i] < draggedCenter) idx = i + 1
      }
      if (idx > crabIndex) idx--
      return Math.max(0, Math.min(idx, crabs.length - 1))
    }

    const shiftSiblings = (targetIndex: number) => {
      for (let i = 0; i < slots.length; i++) {
        if (i === crabIndex) continue
        let shift = 0
        if (targetIndex < crabIndex && i >= targetIndex && i < crabIndex) {
          shift = slotStride
        } else if (targetIndex > crabIndex && i > crabIndex && i <= targetIndex) {
          shift = -slotStride
        }
        slots[i].style.transform = shift ? `translateX(${shift}px)` : ''
      }
    }

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      if (!dragging && Math.abs(dx) < 5) return

      if (!dragging) {
        dragging = true
        isDraggingRef.current = true
        useHoveredCardStore.getState().setToolbarHoveredNode(null)
        draggedSlot.classList.add('toolbar__crab-slot--dragging')
        for (let i = 0; i < slots.length; i++) {
          if (i !== crabIndex) slots[i].classList.add('toolbar__crab-slot--shifting')
        }
      }

      draggedSlot.style.transform = `translateX(${dx}px)`

      const targetIndex = computeTargetIndex(dx)
      if (targetIndex !== prevTargetIndex) {
        prevTargetIndex = targetIndex
        shiftSiblings(targetIndex)
      }
    }

    const onMouseUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)

      // Clean up all inline transforms and classes from siblings
      for (let i = 0; i < slots.length; i++) {
        if (i !== crabIndex) {
          slots[i].style.transform = ''
          slots[i].classList.remove('toolbar__crab-slot--shifting')
        }
      }
      draggedSlot.style.transform = ''
      draggedSlot.classList.remove('toolbar__crab-slot--dragging')

      if (!dragging) {
        isDraggingRef.current = false
        onCrabClick(nodeId, metaKey)
        return
      }

      // Compute target index from final position
      const dx = ev.clientX - startX
      const targetIndex = computeTargetIndex(dx)

      // Use requestAnimationFrame so the FLIP animation sees the old positions
      // before React re-renders with the new order
      requestAnimationFrame(() => {
        isDraggingRef.current = false
      })

      if (targetIndex !== crabIndex) {
        const order = crabs.map(c => c.nodeId)
        const [removed] = order.splice(crabIndex, 1)
        order.splice(targetIndex, 0, removed)
        onCrabReorder(order)
      } else {
        isDraggingRef.current = false
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Triangle navigation indicator animation
  useEffect(() => {
    if (!crabNavEvent || !containerRef.current || !triangleRef.current) return

    const container = containerRef.current
    const triangle = triangleRef.current
    const { fromNodeId, toNodeId } = crabNavEvent

    // Cancel any in-progress animation
    if (navAnimRef.current) {
      navAnimRef.current.cancel()
      navAnimRef.current = null
    }

    // Measure destination position
    const toSlot = container.querySelector<HTMLElement>(`.toolbar__crab-slot[data-node-id="${toNodeId}"]`)
    if (!toSlot) return
    const toX = toSlot.offsetLeft + toSlot.offsetWidth / 2

    // Measure start position
    let fromX: number
    if (fromNodeId) {
      const fromSlot = container.querySelector<HTMLElement>(`.toolbar__crab-slot[data-node-id="${fromNodeId}"]`)
      fromX = fromSlot ? fromSlot.offsetLeft + fromSlot.offsetWidth / 2 : toX
    } else {
      fromX = toX
    }

    // Show triangle at starting position
    triangle.style.opacity = '1'
    triangle.style.left = `${fromX}px`
    // Clear any residual fill from previous animations
    triangle.getAnimations().forEach(a => a.cancel())

    const slideDuration = 250
    const fadeDelay = 100
    const fadeDuration = 300
    let cancelled = false
    let fadeTimeout: ReturnType<typeof setTimeout>
    let fadeAnim: Animation | null = null

    const slideAnim = triangle.animate(
      [{ left: `${fromX}px` }, { left: `${toX}px` }],
      { duration: slideDuration, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }
    )

    slideAnim.onfinish = () => {
      if (cancelled) return
      triangle.style.left = `${toX}px`
      slideAnim.cancel()
      fadeTimeout = setTimeout(() => {
        if (cancelled) return
        fadeAnim = triangle.animate(
          [{ opacity: '1' }, { opacity: '0' }],
          { duration: fadeDuration, fill: 'forwards' }
        )
        fadeAnim.onfinish = () => {
          if (!cancelled) {
            triangle.style.opacity = '0'
            fadeAnim!.cancel()
          }
        }
      }, fadeDelay)
    }

    navAnimRef.current = {
      cancel: () => {
        cancelled = true
        slideAnim.cancel()
        if (fadeAnim) fadeAnim.cancel()
        clearTimeout(fadeTimeout)
      }
    }
  }, [crabNavEvent])

  // Compress crab icons when there are more than 20 so they overlap
  const FULL_COUNT = 20
  const ICON_SIZE = 20
  const DEFAULT_GAP = 6
  const fullWidth = FULL_COUNT * ICON_SIZE + (FULL_COUNT - 1) * DEFAULT_GAP
  const compressed = crabs.length > FULL_COUNT
  const slotMargin = compressed
    ? (fullWidth / crabs.length) - ICON_SIZE
    : DEFAULT_GAP

  return (
    <div className="toolbar__crabs" ref={containerRef}>
      {crabs.map((crab, i) => {
          const speaking = speakingSessions[crab.nodeId]
          const thinking = crab.nodeId in summaryThinking
          const summaryTarget = crab.nodeId === summaryTargetNodeId
          const summaryState = speaking ? 'talking' : thinking ? 'thinking' : 'idle'
          return (
          <div
            key={crab.nodeId}
            className="toolbar__crab-slot"
            data-node-id={crab.nodeId}
            style={{
              marginRight: i < crabs.length - 1 ? slotMargin : 0,
              ...(compressed ? {
                zIndex: i,
                filter: 'drop-shadow(0 0 1.5px rgba(0,0,0,0.9))',
              } : {}),
            }}
          >
            <button
              className={`toolbar__crab toolbar__crab--${crab.color}${indicatorKindClass(crab.kind)}${crab.unviewed ? ' toolbar__crab--attention' : ''}${crab.nodeId === selectedNodeId ? ' toolbar__crab--selected' : ''}${crab.nodeId === hoveredNodeId ? ' toolbar__crab--card-hovered' : ''}${crab.asleep ? ' toolbar__crab--asleep' : ''}`}
              style={{ WebkitMaskImage: `url(${indicatorIconUrl(crab.kind)})`, maskImage: `url(${indicatorIconUrl(crab.kind)})` }}
              onMouseDown={(e) => handleCrabMouseDown(e, i)}
              onMouseEnter={() => {
                if (!isDraggingRef.current) {
                  useHoveredCardStore.getState().setToolbarHoveredNode(crab.nodeId)
                }
              }}
              onMouseLeave={() => {
                useHoveredCardStore.getState().setToolbarHoveredNode(null)
              }}
              data-tooltip={crab.title && crab.title.length > 80 ? crab.title.slice(0, 80) + '\u2026' : crab.title}
              data-tooltip-no-flip
            />
            {summaryTarget && <SummaryBubble state={summaryState} />}
          </div>
          )
      })}
      <div ref={triangleRef} className="toolbar__crab-nav-triangle" />
    </div>
  )
}
