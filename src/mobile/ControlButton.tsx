import { useReceptionistStore } from '@/stores/receptionistStore'

/**
 * Control, the receptionist, beside the talk button: the phone's version of
 * the desktop toolbar's headset. A tap makes Control the voice target — the
 * talk button then speaks to it — or stops it while it is answering; the
 * server decides which. Its colour is the receptionist's state, in the talk
 * button's palette.
 */
export function ControlButton() {
  const target = useReceptionistStore((s) => s.target)
  const phase = useReceptionistStore((s) => s.phase)
  const error = useReceptionistStore((s) => s.error)

  const state = error ? 'error' : phase !== 'ready' ? phase : target ? 'target' : 'idle'
  const label = {
    idle: 'Control — tap to talk to it instead of Summary Chat',
    target: 'Control — your voice goes to Control',
    thinking: 'Control — thinking, tap to stop it',
    synthesizing: 'Control — about to speak, tap to stop it',
    speaking: 'Control — speaking, tap to stop it',
    error: `Control — ${error ?? ''}`
  }[state]

  return (
    <button
      className={`m-control m-control--${state}`}
      aria-label={label}
      aria-pressed={target}
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
