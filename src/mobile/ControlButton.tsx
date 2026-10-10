import type { CSSProperties } from 'react'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { ControlBadges, controlWhereabouts } from '@/components/ControlBadges'

/**
 * Control, the receptionist, left of the microphone. A tap opens its
 * transcript, or closes it (the icon is then a down arrow), and does nothing
 * else: taking Control, letting it go and muting it are the transcript's.
 *
 * Its corners say how those stand (ControlBadges.tsx): muted or not top left,
 * where Control is top right, and a count, as on the rocket, of replies
 * written here muted and not read yet bottom right. Dim while Control is not
 * here. A yellow ring while it thinks; while anything is said through it, bars in the colour
 * of who is speaking — Control, or the agent it quotes — so a voice is never
 * mistaken for the microphone.
 */
export function ControlButton() {
  const open = useControlTranscriptStore((s) => s.open)
  const phase = useReceptionistStore((s) => s.phase)
  const error = useReceptionistStore((s) => s.error)
  const holder = useReceptionistStore((s) => s.holder)
  const mutedHere = useReceptionistStore((s) => s.mutedHere)
  const speaker = useReceptionistStore((s) => s.speaker)
  const unread = useReceptionistStore((s) => s.unread.count)
  const here = holder?.mine === true
  const speaking = phase === 'speaking'

  const label = open ? 'Close the Control transcript'
    : `Control transcript — ${error ?? controlWhereabouts(holder, mutedHere)}${speaking ? `, ${speaker ?? 'Control'} speaking` : ''}${unread ? `, ${unread} unread` : ''}`

  return (
    <button
      className={`m-control${here ? '' : ' m-control--away'}${open ? ' m-control--open' : ''}${speaking ? ' m-control--speaking' : ''}${error ? ' m-control--error' : ''}`}
      style={speaking ? { '--m-speaker': speakerColour(speaker) } as CSSProperties : undefined}
      // Thinking elsewhere is that device's to show.
      data-phase={here && phase === 'thinking' ? 'thinking' : 'ready'}
      aria-label={label}
      aria-expanded={open}
      onClick={() => useControlTranscriptStore.getState().setOpen(!open)}
    >
      {open ? (
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          {/* Down: the transcript goes away. */}
          <path d="M8 2.5v10.5" />
          <path d="M3.5 8.5 8 13l4.5-4.5" />
        </svg>
      ) : speaking ? (
        <span className="m-control__bars" aria-hidden="true"><i /><i /><i /><i /></span>
      ) : (
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          {/* A headset: Control. */}
          <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
          <rect x="1.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
          <rect x="11.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
          <path d="M13 12.5c0 1.5-1.5 2-3.5 2" />
        </svg>
      )}
      <ControlBadges />
      {unread > 0 && <span className="control-badge control-badge--count" aria-hidden="true">{unread}</span>}
    </button>
  )
}

/** Control's voice is white; each agent's a hue of its own, the same every time it speaks. */
export function speakerColour(speaker: string | null): string {
  if (!speaker || speaker === 'Control') return '#ffffff'
  let hash = 0
  for (const char of speaker) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 75% 70%)`
}
