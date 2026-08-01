/**
 * Branded identifier types.
 *
 * Spaceterm has several kinds of id, all of them UUID strings, and two of them
 * are routinely confused because they are equal exactly when nothing has gone
 * wrong yet: a terminal's node id and its pty session id coincide at first
 * launch and diverge the moment the terminal is restarted or resumed. That trap
 * is documented in protocol.ts — and `surfaceAgentType` fell into it anyway,
 * with `getNodeIdForSession(surfaceId) ?? surfaceId`, a fallback that is correct
 * only for a terminal that has never restarted.
 *
 * Branding makes the mix-up a compile error and costs nothing at runtime: the
 * brand is a phantom property that exists only in the type system, so a
 * `NodeId` *is* a string everywhere it matters — `Record` keys, string methods,
 * `JSON.stringify`, socket writes.
 *
 * The cost is that a plain `string` no longer flows into an id parameter
 * implicitly. That is the point, and it is why the constructors below are
 * deliberately named rather than sprinkled `as` casts: each call is a claim
 * about where the value came from, and is greppable when a claim turns out to
 * be wrong.
 */

declare const brand: unique symbol

type Brand<T, B extends string> = T & { readonly [brand]: B }

/**
 * Identifies a node in the canvas graph. Assigned once when the node is
 * created and stable for the node's entire life, across restarts and resumes.
 * This is what the user thinks of as "the terminal".
 */
export type NodeId = Brand<string, 'NodeId'>

/**
 * Identifies one PTY session — a single run of a shell process. A terminal node
 * gets a *new* one every time it is restarted, resumed, or reincarnated.
 *
 * Also called a "surface id" at the script and hook sockets, where it arrives
 * as `SPACETERM_SURFACE_ID`.
 */
export type PtySessionId = Brand<string, 'PtySessionId'>

/**
 * Identifies one agent conversation (Claude, Cursor, or Codex). Owned by the
 * agent, not by spaceterm; one pty session can run several in sequence.
 */
export type ClaudeSessionId = Brand<string, 'ClaudeSessionId'>

/**
 * Assert that a string is a node id.
 *
 * Use at a boundary where the value has just been read from somewhere untyped —
 * a socket message, an environment variable, a persisted document — and the
 * surrounding code establishes which kind of id it is.
 */
export function asNodeId(value: string): NodeId {
  return value as NodeId
}

/** Assert that a string is a pty session id. See {@link asNodeId}. */
export function asPtySessionId(value: string): PtySessionId {
  return value as PtySessionId
}

/** Assert that a string is an agent session id. See {@link asNodeId}. */
export function asClaudeSessionId(value: string): ClaudeSessionId {
  return value as ClaudeSessionId
}

/**
 * A terminal node takes its id from the pty session it was first launched with.
 *
 * This is the one place where the two really are the same value, and it is why
 * they are so easily confused: every restart or resume rebinds the node to a
 * fresh pty session id while its node id stays put, so code that assumes they
 * are interchangeable works right up until the first restart.
 */
export function nodeIdFromFirstPtySession(sessionId: PtySessionId): NodeId {
  return sessionId as string as NodeId
}

/**
 * The ids of the entries in a node map.
 *
 * `Object.keys` returns `string[]`, which is the one place branding is
 * consistently inconvenient. This keeps the cast in a single named place
 * instead of at every iteration site.
 */
export function nodeIdsOf(nodes: Record<string, unknown>): NodeId[] {
  return Object.keys(nodes) as NodeId[]
}

/**
 * The root of the node graph. Every node's `parentId` chain terminates here;
 * there is no node with this id.
 */
export const ROOT_NODE_ID = 'root' as NodeId
