import { useReceptionistStore } from '../../stores/receptionistStore'
import type { ReceptionistPhase } from '../../../../../shared/api'
import { HeadsetIcon } from './icons'
import { useControlTranscriptStore } from '../../stores/controlTranscriptStore'
import { TRANSCRIPT_TOGGLE_ATTR } from '../ControlTranscript'
import { ControlBadges, controlWhereabouts } from '../ControlBadges'

/**
 * The receptionist's toolbar button. A click shows or hides Control's
 * transcript (ControlTranscript.tsx), and does nothing else: taking Control,
 * letting it go and muting it are the transcript's. The button says how
 * those stand, in its corners (ControlBadges.tsx), and is dim while Control
 * is not here and white while the transcript is open. While Control works, a
 * speech bubble takes the eye's corner: cyan while it thinks, amber while it
 * speaks.
 */
export function ControlButton() {
  const phase = useReceptionistStore(s => s.phase)
  const error = useReceptionistStore(s => s.error)
  const holder = useReceptionistStore(s => s.holder)
  const mutedHere = useReceptionistStore(s => s.mutedHere)
  const unread = useReceptionistStore(s => s.unread.count)
  const here = holder?.mine === true
  const open = useControlTranscriptStore((s) => s.open)
  const state = error ? `Control — ${error}`
    : `Control — ${controlWhereabouts(holder, mutedHere)}${unread ? `, ${unread} unread` : ''}`
  return (
    <button
      className={`toolbar__btn toolbar__control toolbar__control--${here ? 'here' : 'away'}`
        + (open ? ' toolbar__btn--active' : '')
        + (error ? ' toolbar__btn--recording' : '')}
      onClick={() => useControlTranscriptStore.getState().setOpen(!open)}
      aria-pressed={open}
      aria-label="Control"
      {...{ [TRANSCRIPT_TOGGLE_ATTR]: '' }}
      data-phase={phase}
      data-tooltip={`${state}. Click to ${open ? 'close' : 'open'} the transcript`}
      data-tooltip-no-flip
    >
      <HeadsetIcon />
      <ControlBadges busy={phase !== 'ready' ? <BusyBubble phase={phase} /> : undefined} />
      {unread > 0 && <span className="control-badge control-badge--count" aria-hidden="true">{unread}</span>}
    </button>
  )
}

/** Thinking until Voice Operator speaks — synthesizing is still a wait — then talking. */
function BusyBubble({ phase }: { phase: Exclude<ReceptionistPhase, 'ready'> }) {
  const talking = phase === 'speaking'
  return (
    <svg
      className={`toolbar__control-busy toolbar__control-busy--${talking ? 'talking' : 'thinking'}`}
      viewBox="0 0 20 16"
      role="img"
      aria-label={talking ? 'Control is speaking' : 'Control is thinking'}
    >
      <path d="M2.5 1.5h15v9h-8l-4.5 4v-4h-2.5z" />
    </svg>
  )
}
