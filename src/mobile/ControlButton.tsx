import { controlLook, useReceptionistStore } from '@/stores/receptionistStore'

/**
 * Control, the receptionist, beside the talk button: the phone's version of
 * the desktop toolbar's headset, with the same three states — black while
 * another device (or none) holds Control, white while this phone does and the
 * talk button speaks to it, magenta while this phone does but the voice last
 * went to Summary Chat. A tap brings Control here, gives it the voice back,
 * or — when white — lets go of it, which silences it; the server decides
 * which. A ring says what it is doing, in the talk button's palette.
 */
export function ControlButton() {
  const target = useReceptionistStore((s) => s.target)
  const phase = useReceptionistStore((s) => s.phase)
  const error = useReceptionistStore((s) => s.error)
  const holder = useReceptionistStore((s) => s.holder)
  const look = controlLook(holder, target)

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
      aria-label={label}
      aria-pressed={look === 'here'}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => window.api.receptionist.select()}
    >
      <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
        <rect x="1.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
        <rect x="11.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
        <path d="M13 12.5c0 1.5-1.5 2-3.5 2" />
      </svg>
    </button>
  )
}
