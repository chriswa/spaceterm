/**
 * A spark running round a round button's rim: a press was taken and what it
 * asked for is on its way — the microphone starting, the words being
 * transcribed. The directory cards' badge spark (index.css,
 * `.directory-card__badge-spark`), at bottom-bar size. Fills its button;
 * the button must be `position: relative`.
 *
 * `gold` is a wait; `amber` a second try after a failure; `white` shows on
 * orange, while the words are waited for.
 */
export function Spark({ tone = 'gold' }: { tone?: 'gold' | 'amber' | 'white' }) {
  return (
    <svg className={`m-spark m-spark--${tone}`} viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r="24" pathLength={100} />
    </svg>
  )
}
