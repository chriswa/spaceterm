import { useCallback, useEffect, useRef } from 'react'
import { helpGroups } from '../lib/help-registry'
import { createWheelAccumulator, classifyWheelEvent } from '../lib/wheel-gesture'

interface HelpModalProps {
  visible: boolean
  onDismiss: () => void
}

const helpWheelAcc = createWheelAccumulator()

export function HelpModal({ visible, onDismiss }: HelpModalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to top when opened
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo(0, 0)
      })
    }
  }, [visible])

  // Wheel gesture: vertical scrolls normally, horizontal/pinch dismisses
  useEffect(() => {
    if (!visible) return
    const el = scrollRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      const gesture = classifyWheelEvent(helpWheelAcc, e)
      if (gesture === 'vertical') return
      e.preventDefault()
      onDismiss()
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [visible, onDismiss])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onDismiss()
    }
  }, [onDismiss])

  if (!visible) return null

  return (
    <div className="help-modal" onKeyDown={handleKeyDown} onMouseDown={(e) => e.stopPropagation()} tabIndex={-1}>
      <div className="help-modal__header">
        <span className="help-modal__title">Keyboard Shortcuts & Tips</span>
        <kbd className="help-modal__dismiss-hint">ESC to close</kbd>
      </div>

      <div className="help-modal__body" ref={scrollRef}>
        {helpGroups.map((group) => (
          <div key={group.title} className="help-modal__group">
            <div className="help-modal__group-title">{group.title}</div>
            {group.description && (
              <div className="help-modal__group-desc">{group.description}</div>
            )}
            <div className="help-modal__entries">
              {group.entries.map((entry, i) => (
                <div key={i} className="help-modal__row">
                  <kbd className="help-modal__keys">{entry.keys}</kbd>
                  <span className="help-modal__desc">{entry.name}{entry.notes && <span className="help-modal__notes"> — {entry.notes}</span>}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
