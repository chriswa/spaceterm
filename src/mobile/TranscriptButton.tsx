import type { CSSProperties } from 'react'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'

/**
 * Control's words, right of the microphone: a tap opens the transcript, or
 * closes it (the icon is then a down arrow). While anything is being said
 * through Control, bars move on it in the colour of who is speaking — Control,
 * or the agent it quotes — so a voice is never mistaken for the microphone.
 * A count, as on the bell, of replies written here muted and not read yet.
 */
export function TranscriptButton() {
  const open = useControlTranscriptStore((s) => s.open)
  const phase = useReceptionistStore((s) => s.phase)
  const speaker = useReceptionistStore((s) => s.speaker)
  const unread = useReceptionistStore((s) => s.unread.count)
  const speaking = phase === 'speaking'
  const label = open ? 'Close the Control transcript'
    : `Control transcript${speaking ? ` — ${speaker ?? 'Control'} speaking` : ''}${unread ? ` — ${unread} unread` : ''}`
  return (
    <button
      className={`m-bar__button m-transcript${open ? ' m-transcript--open' : ''}${speaking ? ' m-transcript--speaking' : ''}`}
      style={speaking ? { '--m-speaker': speakerColour(speaker) } as CSSProperties : undefined}
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
        <span className="m-transcript__bars" aria-hidden="true"><i /><i /><i /><i /></span>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          {/* A speech bubble with lines: what was said. */}
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z" />
          <path d="M8 8h8M8 11.5h5" />
        </svg>
      )}
      {unread > 0 && <span className="m-transcript__count">{unread}</span>}
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
