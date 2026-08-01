/**
 * Version negotiation, shared by both sockets that have it.
 *
 * The scripts socket and the client socket ask the same question — "can this
 * build serve a peer written against version N?" — and the answer has to be
 * phrased the same way, because the failure it prevents is identical: a peer
 * half-understanding a reply and behaving as though it understood.
 *
 * The rule for bumping either version is the same too. Bump on any change an
 * older peer could notice: a removed or renamed message, a field that stops
 * being sent, a changed meaning. Adding a message type or an optional field
 * does not need a bump — an older peer simply will not use it.
 */

/** What a build serves: everything from `min` through `current`, inclusive. */
export interface ProtocolRange {
  readonly min: number
  readonly current: number
}

export interface CompatibilityVerdict {
  compatible: boolean
  /** Human-readable, present only when incompatible. Safe to show a user. */
  error?: string
}

/** `v1-v3`, or just `v1` when the range is a single version. */
export function describeRange(range: ProtocolRange): string {
  return range.min === range.current ? `v${range.min}` : `v${range.min}-v${range.current}`
}

/**
 * Decide whether a peer's protocol version is one this build serves.
 *
 * Both directions matter and they fail differently. A peer that is too old was
 * written against a contract this build has dropped; a peer that is too new
 * expects something this build has never heard of. Saying which is the
 * difference between "update Spaceterm" and "update your script".
 */
export function checkProtocolVersion(
  theirVersion: number,
  range: ProtocolRange
): CompatibilityVerdict {
  if (!Number.isInteger(theirVersion) || theirVersion < 1) {
    return { compatible: false, error: `Invalid protocol version ${theirVersion}; expected a positive integer` }
  }
  if (theirVersion < range.min) {
    return {
      compatible: false,
      error: `Protocol v${theirVersion} is older than this build serves (${describeRange(range)})`
    }
  }
  if (theirVersion > range.current) {
    return {
      compatible: false,
      error: `Protocol v${theirVersion} is newer than this build serves (${describeRange(range)})`
    }
  }
  return { compatible: true }
}
