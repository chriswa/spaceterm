/*
 * Imports nothing, deliberately: `src/shared/server-client.ts` runs in the
 * Electron renderer and in mobile Safari, and reads these as values.
 */

/**
 * Version of the *client* socket contract (`ClientMessage`/`ServerMessage`).
 *
 * Until this existed the client socket was unversioned, on the reasoning that
 * the Electron client ships with the server so the two can never disagree.
 * That is an assumption, not a guarantee: a stale server left running from a
 * previous build, a client launched against a `~/.spaceterm/` socket owned by
 * another checkout, or a future headless client all break it — and the failure
 * mode without a handshake is a client half-understanding a reply and acting
 * as though it understood.
 *
 * Same bump rule as the scripts socket: bump on any change an older peer could
 * notice.
 */
export const CLIENT_PROTOCOL_VERSION = 6

/**
 * Oldest client protocol this build still serves.
 *
 * v1 addressed an unarchive by a single entry id, which cannot name an entry
 * nested inside an archived subtree. `node-unarchive` carries a path instead,
 * so a v1 peer's request is not something this build can honour.
 *
 * v2 is still served. It differs only in speech: it expects a `speak`
 * broadcast this build no longer sends, and drove that broadcast into a
 * `cartesia-read` subprocess that no longer exists on any machine. A v2 client
 * therefore loses nothing here that it had — everything else it asks for is
 * answered exactly as before.
 *
 * v4 and below are also still served. They read a surface's context % and
 * transcript line count from `claude-context`/`claude-session-line-count` and
 * `attached`, which v5 dropped in favour of the node fields `node-updated`
 * already carried — so an older client's card footer shows neither. It also
 * loses the plan-diff button, which was removed.
 *
 * v5 and below name no device in `client-hello`, so they can never hold
 * Control; their Talk To Me toggle, replaced in v6 by holding, does nothing.
 */
export const MIN_CLIENT_PROTOCOL_VERSION = 2
