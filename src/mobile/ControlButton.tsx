import { controlLook, useReceptionistStore } from '@/stores/receptionistStore'

/**
 * Control, the receptionist, left of the microphone: whether Control speaks
 * here. Dim while another device holds it, or none (a small tag names the
 * one that does); solid white with a halo while it speaks on this phone; the
 * same with a slashed speaker while it is here but muted, writing to the
 * transcript instead; magenta while it is here but the voice last went to
 * Summary Chat. A ring turns while it thinks.
 *
 * A tap mutes it when it speaks here, and otherwise has it speak here —
 * unmuted, and talked to again. Letting go of it altogether is the
 * transcript's (its header), as is everything about what was said.
 */
export function ControlButton() {
  const target = useReceptionistStore((s) => s.target)
  const phase = useReceptionistStore((s) => s.phase)
  const error = useReceptionistStore((s) => s.error)
  const holder = useReceptionistStore((s) => s.holder)
  const look = controlLook(holder, target)
  const muted = holder?.mine === true && holder.muted
  const speaking = look === 'here' && !muted

  const label = error
    ? `Control — ${error}`
    : look === 'away'
      ? holder ? `Control — on your ${holder.label}; tap to have it speak here` : 'Control — nobody holds it, so it works silently; tap to have it speak here'
      : muted
        ? 'Control — here, muted: it writes to the transcript; tap to have it speak'
        : look === 'summary'
          ? 'Control — here, but your voice goes to Summary Chat; tap to talk to Control'
          : 'Control — speaking here; tap to mute it'

  return (
    <button
      className={`m-control m-control--${look}${muted ? ' m-control--muted' : ''}${error ? ' m-control--error' : ''}`}
      // Thinking elsewhere is that device's to show.
      data-phase={look !== 'away' && phase === 'thinking' ? 'thinking' : 'ready'}
      aria-label={label}
      aria-pressed={speaking}
      onClick={() => window.api.receptionist.hold(speaking ? 'mute' : 'speak-here')}
    >
      <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
        <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
        <rect x="1.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
        <rect x="11.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
        <path d="M13 12.5c0 1.5-1.5 2-3.5 2" />
      </svg>
      {muted && (
        <span className="m-control__muted" aria-hidden="true">
          {/* A speaker, struck through: here, but not speaking. */}
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1.5 4.5h2l3-2.5v8l-3-2.5h-2z" fill="currentColor" />
            <path d="M8.5 4.5l3 3M11.5 4.5l-3 3" />
          </svg>
        </span>
      )}
      {look === 'away' && holder && <span className="m-control__where" aria-hidden="true">{holder.label}</span>}
    </button>
  )
}
