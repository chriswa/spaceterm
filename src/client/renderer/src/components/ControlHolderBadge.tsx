import { useReceptionistStore, type ReceptionistHolding } from '../stores/receptionistStore'

/**
 * What the foot of the transcript says about where Control is, or null while
 * it is here — silent or aloud, Control is working and needs no caption. Two
 * things are worth saying: Control is attached to another device, so this one
 * only watches; or it is unattached — nobody holds it — so it carries on
 * working but can neither speak nor write to the user until a device takes it.
 */
export function holderBadgeText(holder: ReceptionistHolding | null): string | null {
  if (!holder) return "Control is unattached — can't send messages"
  if (holder.mine) return null
  return `Control is attached to ${holder.label}`
}

/** The badge over the box to type in, under the unread bar: see `holderBadgeText`. */
export function ControlHolderBadge() {
  const text = useReceptionistStore((s) => holderBadgeText(s.holder))
  if (!text) return null
  return <div className="control-transcript__holder-badge" role="status">{text}</div>
}
