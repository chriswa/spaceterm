import type { ReactNode } from 'react'
import { controlMode, useReceptionistStore, type ReceptionistHolding } from '../stores/receptionistStore'

/**
 * Control's headset, the same on the Mac's toolbar and the phone's bar. Sound
 * comes out of both earpieces only while Control speaks here (`controlMode`);
 * released or in text, there is none, whatever mute the server remembers for
 * this device. The viewBox is wide enough for the sound either way, so the
 * headset does not shift.
 */
export function ControlHeadset({ size }: { size?: number }) {
  const speaks = useReceptionistStore((s) => controlMode(s) === 'speak')
  return (
    <svg
      className="control-headset"
      viewBox="-5.5 0 27 16"
      width={size ? (size * 27) / 16 : `${27 / 16}em`}
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
      {speaks && (
        <g className="control-headset__sound" strokeWidth="1.1">
          {/* Arcs about each earpiece, a quarter turn each, opening outward.
              None is drawn closer than radius 5.5, so a clear gap parts the
              sound from the headset. */}
          <path d="M-.89 6.61a5.5 5.5 0 0 0 0 7.78" />
          <path d="M-2.3 5.2a7.5 7.5 0 0 0 0 10.61" />
          <path d="M16.89 6.61a5.5 5.5 0 0 1 0 7.78" />
          <path d="M18.3 5.2a7.5 7.5 0 0 1 0 10.61" />
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
 * (Speaking here or not is the headset's own sound, ControlHeadset.)
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

/** What the button shows, in words, for a label or tooltip: where Control is, and here, whether it speaks or writes. */
export function controlWhereabouts(holder: ReceptionistHolding | null, mutedHere: boolean): string {
  switch (controlMode({ holder, mutedHere })) {
    case 'speak': return 'Control is here, speaking aloud'
    case 'text': return 'Control is here, in text'
    case 'released': return holder ? `Control is on your ${holder.label}` : 'Nobody holds Control'
  }
}
