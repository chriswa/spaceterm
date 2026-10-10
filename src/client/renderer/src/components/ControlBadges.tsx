import type { ReactNode } from 'react'
import { useReceptionistStore, type ReceptionistHolding } from '../stores/receptionistStore'

/** The mute badge's speech bubble, and what it holds: a cross while muted, a voice while not. */
const BUBBLE = 'M2.5 1.5h7A1.5 1.5 0 0 1 11 3v4a1.5 1.5 0 0 1-1.5 1.5H5.5L3 10.75V8.5h-.5A1.5 1.5 0 0 1 1 7V3a1.5 1.5 0 0 1 1.5-1.5z'
const CROSS = 'M4.6 3.6l2.8 2.8M7.4 3.6L4.6 6.4'
const VOICE = 'M4 4.25v1.5M6 3.25v3.5M8 4.25v1.5'

/**
 * The corners of the Control button, the same on the Mac's toolbar and the
 * phone's bottom bar: the button itself only opens the transcript, where
 * Control is taken, let go, muted and unmuted, so it shows the outcome of
 * those here.
 *
 * Top left, a speech bubble: yellow with a cross while this device has muted
 * Control, white with a voice in it while not — faded while Control is not
 * here, when the mute only says how it would arrive. Top right, where Control
 * is: an eye while this device holds it, the holder's name while another
 * does, nothing while nobody does. `busy` stands in for the eye — the Mac's
 * bubble while Control works, which says the same and more.
 */
export function ControlBadges({ busy }: { busy?: ReactNode }) {
  const holder = useReceptionistStore((s) => s.holder)
  const mutedHere = useReceptionistStore((s) => s.mutedHere)
  const here = holder?.mine === true
  return (
    <>
      <span className={`control-badge control-badge--voice${here ? '' : ' control-badge--faded'}`} aria-hidden="true">
        <svg viewBox="0 0 12 12">
          <path className="control-badge__bubble" data-muted={mutedHere || undefined} d={BUBBLE} />
          <path className="control-badge__mark" d={mutedHere ? CROSS : VOICE} />
        </svg>
      </span>
      {here
        ? busy ?? (
          <span className="control-badge control-badge--held" aria-hidden="true">
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="7" className="control-badge__disc" />
              <path d="M3.5 8S5.3 5 8 5s4.5 3 4.5 3-1.8 3-4.5 3-4.5-3-4.5-3z" className="control-badge__eye" />
              <circle cx="8" cy="8" r="1.4" className="control-badge__pupil" />
            </svg>
          </span>
        )
        : holder && <span className="control-badge control-badge--where" aria-hidden="true">{holder.label}</span>}
    </>
  )
}

/** What the badges say, in words, for a label or tooltip: where Control is, and whether it is muted here. */
export function controlWhereabouts(holder: ReceptionistHolding | null, mutedHere: boolean): string {
  const where = holder?.mine ? 'Control is here' : holder ? `Control is on your ${holder.label}` : 'Nobody holds Control'
  return `${where}, ${mutedHere ? 'muted here' : 'unmuted here'}`
}
