import { useEffect, useRef, useState } from 'react'

interface ToastItem {
  id: number
  message: string
  createdAt: number
}

interface ToastProps {
  toasts: ToastItem[]
  onExpire: (id: number) => void
}

const TOAST_LIFETIME_MS = 5000
const FADE_DURATION_MS = 1000
const LINE_HEIGHT = 22
const FONT_SIZE = 13
const BOTTOM_MARGIN = 56

export function Toast({ toasts, onExpire }: ToastProps) {
  const [now, setNow] = useState(Date.now())
  const rafRef = useRef(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const [svgHeight, setSvgHeight] = useState(window.innerHeight)

  useEffect(() => {
    if (toasts.length === 0) return
    const tick = () => {
      setNow(Date.now())
      if (svgRef.current) setSvgHeight(svgRef.current.clientHeight)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [toasts.length])

  // Expire toasts that have fully faded
  useEffect(() => {
    for (const t of toasts) {
      const age = now - t.createdAt
      if (age >= TOAST_LIFETIME_MS + FADE_DURATION_MS) {
        onExpire(t.id)
      }
    }
  }, [now, toasts, onExpire])

  if (toasts.length === 0) return null

  // Base Y: bottom of SVG minus margin. This is where the newest toast's baseline sits.
  const baseY = svgHeight - BOTTOM_MARGIN

  return (
    <svg ref={svgRef} className="toast-container" style={{ width: '100%', height: '100%' }}>
      {toasts.map((t, i) => {
        const age = now - t.createdAt

        // Slot: newest (last in array) = slot 0, oldest (first) = further up.
        const slotFromBottom = (toasts.length - 1 - i) * LINE_HEIGHT

        // Fade: fully opaque until TOAST_LIFETIME_MS, then fade over FADE_DURATION_MS
        let opacity = 1
        if (age > TOAST_LIFETIME_MS) {
          opacity = Math.max(0, 1 - (age - TOAST_LIFETIME_MS) / FADE_DURATION_MS)
        }

        // On the very first frame, place one LINE_HEIGHT below the target slot
        // so the CSS transition eases it upward into position.
        const isEntering = age < 20
        const ty = isEntering
          ? baseY - slotFromBottom + LINE_HEIGHT
          : baseY - slotFromBottom

        return (
          <text
            key={t.id}
            x={12}
            y={0}
            fontSize={FONT_SIZE}
            fontFamily="system-ui, -apple-system, sans-serif"
            fontWeight={500}
            fill="white"
            stroke="black"
            strokeWidth={3.5}
            strokeLinejoin="round"
            paintOrder="stroke"
            style={{
              transform: `translateY(${ty}px)`,
              transition: 'transform 300ms cubic-bezier(0.25, 0.1, 0.25, 1)',
              opacity,
            }}
          >
            {t.message}
          </text>
        )
      })}
    </svg>
  )
}
