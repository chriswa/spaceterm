import { useReceptionistStore, type ReceptionistHolding } from '../stores/receptionistStore'

/**
 * What the foot of the transcript says about where Control is, or null while
 * it is here — silent or aloud, Control is working and needs no caption. Two
 * things are worth saying: Control is on another device, so this one only
 * watches; or nobody holds it, so it has stopped until a device takes it.
 */
export function holderBadgeText(holder: ReceptionistHolding | null): string | null {
  if (!holder) return 'Control has stopped: no device is listening or reading'
  if (holder.mine) return null
  return `Control is active on ${holder.label}`
}

/** The badge at the bottom of the transcript's content: see `holderBadgeText`. */
export function ControlHolderBadge() {
  const text = useReceptionistStore((s) => holderBadgeText(s.holder))
  if (!text) return null
  return <div className="control-transcript__holder-badge" role="status">{text}</div>
}
