import { controlLook, useReceptionistStore } from '@/stores/receptionistStore'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { useLongPress } from '@/hooks/useLongPress'

/**
 * Control, the receptionist, beside the talk button: the phone's version of
 * the desktop toolbar's headset, with the same three states — black while
 * another device (or none) holds Control, white while this phone does and the
 * talk button speaks to it, magenta while this phone does but the voice last
 * went to Summary Chat. A tap brings Control here, gives it the voice back,
 * or — when white — lets go of it, which silences it; the server decides
 * which. A ring says what it is doing, in the talk button's palette. A long
 * press opens the transcript instead, over the screen above the bar; while it
 * is open the headset is a down arrow, and a tap closes it.
 */
export function ControlButton() {
  const target = useReceptionistStore((s) => s.target)
  const phase = useReceptionistStore((s) => s.phase)
  const error = useReceptionistStore((s) => s.error)
  const holder = useReceptionistStore((s) => s.holder)
  const look = controlLook(holder, target)
  const transcriptOpen = useControlTranscriptStore((s) => s.open)
  const press = useLongPress(
    () => transcriptOpen ? useControlTranscriptStore.getState().setOpen(false) : window.api.receptionist.select(),
    () => useControlTranscriptStore.getState().setOpen(true),
  )

  const label = error
    ? `Control — ${error}`
    : look === 'away'
      ? holder ? `Control — on your ${holder.label}, tap to bring it here` : 'Control — nobody holds it, so it works silently; tap to bring it here'
      : look === 'summary'
        ? 'Control — here, but your voice goes to Summary Chat; tap to talk to Control'
        : phase === 'ready'
          ? 'Control — your voice goes to Control; tap to let go of it, which silences it'
          : `Control — ${phase === 'speaking' ? 'speaking' : 'thinking'}; tap to stop it and let go of it`

  return (
    <button
      className={`m-control m-control--${look}${error ? ' m-control--error' : ''}`}
      // Busy elsewhere is that device's to show.
      data-phase={look === 'away' ? 'ready' : phase}
      aria-label={transcriptOpen ? 'Close the Control transcript' : `${label}. Hold for the transcript`}
      aria-pressed={look === 'here'}
      {...press}
    >
      {transcriptOpen ? (
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          {/* Down: the transcript goes away. */}
          <path d="M8 2.5v10.5" />
          <path d="M3.5 8.5 8 13l4.5-4.5" />
        </svg>
      ) : (
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
          <rect x="1.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
          <rect x="11.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
          <path d="M13 12.5c0 1.5-1.5 2-3.5 2" />
        </svg>
      )}
    </button>
  )
}
