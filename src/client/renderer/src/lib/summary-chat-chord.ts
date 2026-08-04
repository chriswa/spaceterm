import type { NodeId } from '../../../../shared/ids'
import type { SummaryChatToggleResult } from '../../../../shared/api'
import { playSummaryChatCancelledCue, playSummaryChatStartedCue } from './summary-chat-wait-cue'

/**
 * What one press of the Summary Chat chord does with the answer it gets back.
 *
 * The press is a toggle whose meaning only the server can decide — it owns the
 * conversations, and a client's view of them lags by a broadcast hop. So the
 * feedback cannot be chosen at press time; it is chosen here, from the outcome.
 * The old handler guessed, and played a *start* chirp at a listener whose press
 * had in fact stopped something.
 *
 * This lives away from `App.tsx` because it is the part with a decision in it.
 * The handler there is four hundred lines of condition-then-effect, and an
 * outcome-to-feedback mapping buried inside that is a mapping nothing can test.
 */
export interface SummaryChatChordDeps {
  toggle(nodeId: NodeId | undefined): Promise<SummaryChatToggleResult>
  /** Confirming chirp: an answer is on its way. */
  started(): void
  /** Abort chirp: something was cut off. */
  cancelled(): void
  /** Nothing to start and nothing to stop — say why. */
  rejected(message: string): void
}

const FALLBACK_REJECTION = 'Focus an agent terminal to start Summary Chat.'

/**
 * Press the chord for `nodeId`, or for nothing at all.
 *
 * `undefined` is a real argument, not a missing one: a press with no eligible
 * surface focused still cancels, because silencing an answer must not depend on
 * where the listener happens to be looking.
 */
export async function pressSummaryChatChord(
  nodeId: NodeId | undefined,
  deps: SummaryChatChordDeps,
): Promise<void> {
  const { outcome, message } = await deps.toggle(nodeId)
  if (outcome === 'started') return deps.started()
  if (outcome === 'cancelled') return deps.cancelled()
  deps.rejected(message ?? FALLBACK_REJECTION)
}

/** The cues the real app plays. Split out so a test supplies silence instead. */
export const REAL_CHORD_CUES = {
  started: playSummaryChatStartedCue,
  cancelled: playSummaryChatCancelledCue,
} as const
