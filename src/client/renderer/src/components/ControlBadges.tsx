import type { ReactNode } from 'react'
import { useReceptionistStore, type ReceptionistHolding } from '../stores/receptionistStore'

/**
 * Control's headset, the same on the Mac's toolbar and the phone's bar. While
 * Control is unmuted here, sound comes out of both earpieces; no sound is
 * muted. The viewBox is wide enough for the sound either way, so muting does
 * not shift the headset.
 */
export function ControlHeadset({ size }: { size?: number }) {
  const mutedHere = useReceptionistStore((s) => s.mutedHere)
  return (
    <svg
      className="control-headset"
      viewBox="-3.5 0 23 16"
      width={size ? (size * 23) / 16 : `${23 / 16}em`}
      height={size ?? '1em'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M2.5 9.5V8a5.5 5.5 0 0 1 11 0v1.5" />
      <rect x="1.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
      <rect x="11.75" y="8.5" width="2.5" height="4" rx="1" fill="currentColor" fillOpacity="0.25" />
      <path d="M13 12.5c0 1.5-1.5 2-3.5 2" />
      {!mutedHere && (
        <g className="control-headset__sound" strokeWidth="1.1">
          {/* Arcs about each earpiece, a quarter turn each, opening outward. */}
          <path d="M.53 8.03a3.5 3.5 0 0 0 0 4.94" />
          <path d="M-.89 6.61a5.5 5.5 0 0 0 0 7.78" />
          <path d="M15.47 8.03a3.5 3.5 0 0 1 0 4.94" />
          <path d="M16.89 6.61a5.5 5.5 0 0 1 0 7.78" />
        </g>
      )}
    </svg>
  )
}

/**
 * What lies over the Control button, the same on the Mac's toolbar and the
 * phone's bar: the button itself only opens the transcript, where Control is
 * taken, let go, muted and unmuted, so it shows the outcome of those here.
 *
 * A big red X across the button while this device does not hold Control.
 * Top right, the holder's name while another device does. `busy` takes the
 * top right while Control is here — the Mac's bubble while Control works.
 * (Muted or not is the headset's own sound, ControlHeadset.)
 */
export function ControlBadges({ busy }: { busy?: ReactNode }) {
  const holder = useReceptionistStore((s) => s.holder)
  const here = holder?.mine === true
  return (
    <>
      {!here && (
        <span className="control-cross" aria-hidden="true">
          <svg viewBox="0 0 10 10">
            <path d="M2.2 2.2l5.6 5.6M7.8 2.2l-5.6 5.6" />
          </svg>
        </span>
      )}
      {here ? busy : holder && <span className="control-badge control-badge--where" aria-hidden="true">{holder.label}</span>}
    </>
  )
}

/** What the button shows, in words, for a label or tooltip: where Control is, and whether it is muted here. */
export function controlWhereabouts(holder: ReceptionistHolding | null, mutedHere: boolean): string {
  const where = holder?.mine ? 'Control is here' : holder ? `Control is on your ${holder.label}` : 'Nobody holds Control'
  return `${where}, ${mutedHere ? 'muted here' : 'unmuted here'}`
}
