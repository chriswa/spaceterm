import { controlLook, useReceptionistStore } from '../../stores/receptionistStore'
import { useSummaryBubble, BUBBLE_STATE } from '../../mods/summary-chat/bubble-facet'
import { HeadsetIcon } from './icons'
import { useControlTranscriptStore } from '../../stores/controlTranscriptStore'
import { TRANSCRIPT_TOGGLE_ATTR } from '../ControlTranscript'
import { ControlBadges, controlWhereabouts } from '../ControlBadges'

/**
 * The receptionist's toolbar button. A click shows or hides Control's
 * transcript (ControlTranscript.tsx), and does nothing else: taking Control,
 * letting it go and muting it are the transcript's. The button says how
 * those stand, in its corners (ControlBadges.tsx), and its fill says whose
 * Control's voice is: dim while it is not here, magenta while it is here but
 * the voice last went to Summary Chat, white while the transcript is open.
 * The Summary Chat bubble takes the eye's corner while Control works, so
 * "thinking" and "speaking" read the same as on a crab.
 */
export function ControlButton() {
  const target = useReceptionistStore(s => s.target)
  const phase = useReceptionistStore(s => s.phase)
  const error = useReceptionistStore(s => s.error)
  const holder = useReceptionistStore(s => s.holder)
  const mutedHere = useReceptionistStore(s => s.mutedHere)
  const unread = useReceptionistStore(s => s.unread.count)
  const look = controlLook(holder, target)
  const { Component: Bubble } = useSummaryBubble()
  const open = useControlTranscriptStore((s) => s.open)
  const state = error ? `Control — ${error}`
    : `Control — ${controlWhereabouts(holder, mutedHere)}${look === 'summary' ? ', your voice goes to Summary Chat' : ''}${unread ? `, ${unread} unread` : ''}`
  return (
    <button
      className={`toolbar__btn toolbar__control toolbar__control--${look}`
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
      <ControlBadges busy={phase !== 'ready' ? <Bubble state={BUBBLE_STATE[phase]} /> : undefined} />
      {unread > 0 && <span className="control-badge control-badge--count" aria-hidden="true">{unread}</span>}
    </button>
  )
}
