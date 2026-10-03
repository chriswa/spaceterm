import { useReceptionistStore } from '../../stores/receptionistStore'
import { useSummaryBubble, BUBBLE_STATE } from '../../mods/summary-chat/bubble-facet'
import type { SummaryChatPhase } from '../../../../../shared/api'
import { HeadsetIcon, SpeakUpIcon } from './icons'

/**
 * The receptionist's two toolbar controls. Both are standalone: their state is
 * the server's, mirrored by `receptionistStore`, and a click only asks.
 */

function controlTooltip(target: boolean, phase: SummaryChatPhase, error: string | null): string {
  if (error) return `Control — ${error}`
  if (phase === 'speaking') return 'Control — Speaking. Click to stop it'
  if (phase !== 'ready') return 'Control — Thinking. Click to stop it'
  if (target) return 'Control — Your voice goes to Control'
  return 'Control — Talk to Control about every agent, instead of Summary Chat'
}

/**
 * Make Control the voice target, or stop it mid-answer — the server decides
 * which. Lit while it is the target; the Summary Chat bubble rides on it,
 * so "listening", "thinking" and "speaking" read the same as on a crab.
 */
export function ControlButton() {
  const target = useReceptionistStore(s => s.target)
  const phase = useReceptionistStore(s => s.phase)
  const error = useReceptionistStore(s => s.error)
  const { Component: Bubble } = useSummaryBubble()
  // It may be busy without being the target: speaking up unprompted.
  const showBubble = target || phase !== 'ready'
  return (
    <button
      className={'toolbar__btn toolbar__control'
        + (target ? ' toolbar__btn--active' : '')
        + (error ? ' toolbar__btn--recording' : '')}
      onClick={() => window.api.receptionist.select()}
      aria-pressed={target}
      aria-label="Control"
      data-phase={phase}
      data-tooltip={controlTooltip(target, phase, error)}
      data-tooltip-no-flip
    >
      <HeadsetIcon />
      {showBubble && <Bubble state={BUBBLE_STATE[phase]} />}
    </button>
  )
}

/** Whether Control may speak up on its own. Shared by every client, like auto-stamps. */
export function ControlTalkToMeToggle() {
  const enabled = useReceptionistStore(s => s.talkToMe)
  return (
    <button
      className={'toolbar__btn' + (enabled ? ' toolbar__btn--active' : '')}
      // The store follows the server's broadcast rather than the click.
      onClick={() => window.api.receptionist.setTalkToMe(!enabled)}
      aria-pressed={enabled}
      aria-label="Control may speak up"
      data-tooltip={enabled ? 'Talk To Me — Control speaks up when something it is watching for happens' : 'Talk To Me — Control speaks only when spoken to'}
      data-tooltip-no-flip
    >
      <SpeakUpIcon />
    </button>
  )
}
