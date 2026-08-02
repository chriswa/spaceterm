import type { ComponentType } from 'react'
import { registerFacet } from '../../lib/theme/registry'
import { useModFacet } from '../../hooks/useFacet'

/**
 * The summary-chat speech bubble, as a mod-owned themeable facet.
 *
 * ## Why this file is shaped like a mod
 *
 * The summarization system — a surface that thinks, speaks, and is the target
 * for voice follow-ups — is on its way out of the base app and into a mod.
 * Its indicator is the first piece to make the trip, because it is the piece
 * themes will want an opinion about: a theme may not want a *speech bubble* at
 * all, and almost certainly wants its own colours.
 *
 * Everything here is what a mod living outside this repo would write, and
 * nothing in `lib/theme` knows this file exists:
 *
 * - The **id is namespaced** to the mod, so two mods can both have a `bubble`.
 * - The **type is owned here.** `lib/theme` stores the value as `unknown`; the
 *   typed accessor below is what makes it safe to use, and it is exported by
 *   the mod rather than provided by the base.
 * - The **default is registered here**, not added to the base's
 *   `DEFAULT_FACETS`, so uninstalling the mod removes the facet entirely
 *   rather than leaving a stub behind.
 * - **Per-theme variants live in `byTheme`.** The grid theme gets a flatter,
 *   monochrome mark without the base repo's theme definition importing
 *   anything from here — which it could not do anyway, since a mod may be
 *   absent. The dependency points mod → base, only.
 */

export const SUMMARY_BUBBLE_FACET = 'summary-chat:bubble' as const

/** What the indicator is currently saying about a surface. */
export type SummaryBubbleState = 'idle' | 'thinking' | 'talking'

export interface SummaryBubbleProps {
  state: SummaryBubbleState
}

export interface SummaryBubbleFacet {
  readonly id: string
  readonly label: string
  readonly Component: ComponentType<SummaryBubbleProps>
}

/**
 * The original: a filled speech bubble, cyan while thinking, amber while
 * speaking. Colour and glow come from `.toolbar__summary-bubble--*`.
 */
function SpeechBubble({ state }: SummaryBubbleProps) {
  return (
    <svg
      className={`toolbar__summary-bubble toolbar__summary-bubble--${state}`}
      viewBox="0 0 20 16"
      role="img"
      aria-label={ariaLabel(state)}
    >
      <path d="M2.5 1.5h15v9h-8l-4.5 4v-4h-2.5z" />
    </svg>
  )
}

/**
 * A monochrome variant for themes with no colour language of their own: a
 * bracket that fills in as the surface goes from targeted to thinking to
 * speaking, so the state reads by *amount* rather than by hue.
 */
function TechnicalMark({ state }: SummaryBubbleProps) {
  return (
    <svg
      className={`toolbar__summary-bubble toolbar__summary-bubble--technical toolbar__summary-bubble--${state}`}
      viewBox="0 0 20 16"
      role="img"
      aria-label={ariaLabel(state)}
    >
      <path d="M3 2.5h14v8h-14z" fill="none" strokeWidth="1.6" />
      {state !== 'idle' && <rect x="5.5" y="5" width="9" height="3" />}
      {state === 'talking' && <rect x="8.5" y="11.5" width="3" height="3" />}
    </svg>
  )
}

function ariaLabel(state: SummaryBubbleState): string {
  if (state === 'talking') return 'Summary Chat is speaking'
  if (state === 'thinking') return 'Summary Chat is thinking'
  return 'Voice follow-ups target this surface'
}

export const SUMMARY_BUBBLES = {
  speech: { id: 'speech', label: 'Speech bubble', Component: SpeechBubble },
  technical: { id: 'technical', label: 'Technical mark', Component: TechnicalMark },
} as const satisfies Record<string, SummaryBubbleFacet>

registerFacet<SummaryBubbleFacet>({
  id: SUMMARY_BUBBLE_FACET,
  defaultValue: SUMMARY_BUBBLES.speech,
  // The mod dresses itself for the themes it knows about. A theme it has never
  // heard of gets the default, and no theme has to know this mod exists.
  byTheme: {
    grid: SUMMARY_BUBBLES.technical,
  },
})

/**
 * The typed accessor this mod exports.
 *
 * Non-null: registration above ran when this module was imported, and only
 * this module's own consumers call it. A *different* mod reading this facet
 * would use `useModFacet` directly and handle `undefined`, since this mod
 * might not be installed.
 */
export function useSummaryBubble(): SummaryBubbleFacet {
  return useModFacet<SummaryBubbleFacet>(SUMMARY_BUBBLE_FACET) ?? SUMMARY_BUBBLES.speech
}
