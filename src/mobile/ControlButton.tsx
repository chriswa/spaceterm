import type { CSSProperties } from 'react'
import { useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { ControlBadges, ControlHeadset, controlWhereabouts } from '@/components/ControlBadges'

/**
 * Control, the receptionist, left of the microphone. A tap opens its
 * transcript, or closes it, and does nothing else: taking Control, letting it
 * go and muting it are the transcript's.
 *
 * It shows how those stand (ControlBadges.tsx): sound from the headset while
 * Control speaks here, a red X while Control is not here (when it is also dim), the
 * holder's name top right while another device has it, and a count, as on the
 * rocket, of replies written here muted and not read yet bottom right. Filled
 * while the transcript is open. A yellow ring while it thinks; while anything
 * is said through it, a ring in the colour of who is speaking — Control, or
 * the agent it quotes — so a voice is never mistaken for the microphone.
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

  const label = `${open ? 'Close the Control transcript' : 'Control transcript'} — ${error ?? controlWhereabouts(holder, mutedHere)}${speaking ? `, ${speaker ?? 'Control'} speaking` : ''}${unread ? `, ${unread} unread` : ''}`

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
      <ControlHeadset size={22} />
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
