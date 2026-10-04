import { controlLook, useReceptionistStore, type ControlLook, type ReceptionistHolding } from '../../stores/receptionistStore'
import { useSummaryBubble, BUBBLE_STATE } from '../../mods/summary-chat/bubble-facet'
import type { SummaryChatPhase } from '../../../../../shared/api'
import { HeadsetIcon } from './icons'

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
 * same as on a crab.
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
  return (
    <button
      className={`toolbar__btn toolbar__control toolbar__control--${look}`
        + (look === 'here' ? ' toolbar__btn--active' : '')
        + (error ? ' toolbar__btn--recording' : '')}
      onClick={() => window.api.receptionist.select()}
      aria-pressed={look === 'here'}
      aria-label="Control"
      data-phase={phase}
      data-tooltip={controlTooltip(look, holder, phase, error)}
      data-tooltip-no-flip
    >
      <HeadsetIcon />
      {showBubble && <Bubble state={BUBBLE_STATE[phase]} />}
    </button>
  )
}
