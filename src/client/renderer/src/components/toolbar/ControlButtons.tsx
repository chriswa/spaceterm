import { controlLook, useReceptionistStore, type ControlLook, type ReceptionistHolding } from '../../stores/receptionistStore'
import { useSummaryBubble, BUBBLE_STATE } from '../../mods/summary-chat/bubble-facet'
import type { SummaryChatPhase } from '../../../../../shared/api'
import { HeadsetIcon, TranscriptIcon } from './icons'
import { useLongPress } from '../../hooks/useLongPress'
import { useControlTranscriptStore } from '../../stores/controlTranscriptStore'
import { TRANSCRIPT_TOGGLE_ATTR } from '../ControlTranscript'

/**
 * The receptionist's toolbar button. Standalone: its state is the server's,
 * mirrored by `receptionistStore`, and a click only asks.
 */

export function controlTooltip(look: ControlLook, holder: ReceptionistHolding | null, phase: SummaryChatPhase, error: string | null): string {
  if (error) return `Control — ${error}`
  if (look === 'away') {
    return holder
      ? `Control — On your ${holder.label}. Click to bring it here`
      : 'Control — Nobody holds it, so it works silently. Click to bring it here'
  }
  if (look === 'summary') return 'Control — Here, but your voice goes to Summary Chat. Click to talk to Control'
  if (phase === 'speaking') return 'Control — Speaking. Click to stop it and let go of it'
  if (phase !== 'ready') return 'Control — Thinking. Click to stop it and let go of it'
  return 'Control — Here, and your voice goes to it. Click to let go of it, which silences it'
}

/**
 * Control: black while another device (or none) holds it, white while it is
 * here and your voice goes to it, magenta while it is here but your voice
 * last went to Summary Chat. A click brings it here, gives it your voice back,
 * or — when white — lets go of it, which silences it; the server decides
 * which. Going black on its own means another device took it. The Summary Chat
 * bubble rides on it while it is here, so "thinking" and "speaking" read the
 * same as on a crab. A long press opens the transcript instead (ControlTranscript.tsx),
 * and a click while it is open closes it.
 */
export function ControlButton() {
  const target = useReceptionistStore(s => s.target)
  const phase = useReceptionistStore(s => s.phase)
  const error = useReceptionistStore(s => s.error)
  const holder = useReceptionistStore(s => s.holder)
  const look = controlLook(holder, target)
  const { Component: Bubble } = useSummaryBubble()
  // Busy elsewhere is that device's to show.
  const showBubble = look !== 'away' && (look === 'here' || phase !== 'ready')
  // While the transcript is open, a click closes it, as the phone's down arrow does.
  const transcriptOpen = useControlTranscriptStore((s) => s.open)
  const press = useLongPress(
    () => transcriptOpen ? useControlTranscriptStore.getState().setOpen(false) : window.api.receptionist.select(),
    () => useControlTranscriptStore.getState().setOpen(true),
  )
  return (
    <button
      className={`toolbar__btn toolbar__control toolbar__control--${look}`
        + (look === 'here' ? ' toolbar__btn--active' : '')
        + (error ? ' toolbar__btn--recording' : '')}
      {...press}
      aria-pressed={look === 'here'}
      aria-label="Control"
      {...{ [TRANSCRIPT_TOGGLE_ATTR]: '' }}
      data-phase={phase}
      data-tooltip={transcriptOpen ? 'Control — Click to close the transcript' : `${controlTooltip(look, holder, phase, error)}. Hold for the transcript`}
      data-tooltip-no-flip
    >
      <HeadsetIcon />
      {showBubble && <Bubble state={BUBBLE_STATE[phase]} />}
    </button>
  )
}

/**
 * Shows and hides Control's transcript with a click, beside the Control
 * button, whose long press does the same.
 */
export function ControlTranscriptButton() {
  const open = useControlTranscriptStore((s) => s.open)
  return (
    <button
      className={'toolbar__btn' + (open ? ' toolbar__btn--active' : '')}
      onClick={() => useControlTranscriptStore.getState().setOpen(!open)}
      aria-pressed={open}
      aria-label="Control transcript"
      {...{ [TRANSCRIPT_TOGGLE_ATTR]: '' }}
      data-tooltip={open ? 'Hide Control\'s transcript' : 'Show Control\'s transcript'}
      data-tooltip-no-flip
    >
      <TranscriptIcon />
    </button>
  )
}
