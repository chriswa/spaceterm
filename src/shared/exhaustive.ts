/**
 * Exhaustiveness guards for discriminated-union dispatch.
 *
 * Spaceterm routes 100+ message variants across five unions (`ClientMessage`,
 * `ServerMessage`, `IngestMessage`, `ScriptMessage`, `DaemonMessage`). Without
 * a guard, adding a variant compiles cleanly and the message is silently
 * dropped by whichever switch was not updated — the failure mode is "nothing
 * happens", which is the most expensive kind to debug.
 *
 * Which of the two to use depends on where the value came from.
 */

/** Best-effort runtime description of an off-union value, for log messages. */
function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object' && 'type' in value) {
    const t = (value as { type: unknown }).type
    return typeof t === 'string' ? t : String(t)
  }
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * For unions the process controls end to end, where an unhandled variant is a
 * programming error rather than bad input. Reaching this at runtime means the
 * union and the switch have drifted apart, so it throws.
 *
 * @example
 *   default:
 *     assertNever(node, 'renderNode')
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${describe(value)}`)
}

/**
 * For dispatch at a socket boundary, where the value genuinely can be off-union
 * at runtime — an older client, a hand-written script, a future mod — and
 * throwing would take down a connection over someone else's typo.
 *
 * The `never` parameter still makes it a compile error to add a variant without
 * handling it; the return value is the offending `type` for logging. This is
 * the shape a mod API needs: strict against our own drift, forgiving of theirs.
 *
 * @example
 *   default: {
 *     const unknownType = unhandledVariant(msg)
 *     console.error(`[scripts] Unknown message type: ${unknownType}`)
 *     break
 *   }
 */
export function unhandledVariant(value: never): string {
  return describe(value)
}
