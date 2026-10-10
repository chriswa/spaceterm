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
export const CLIENT_PROTOCOL_VERSION = 17

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
 *
 * v6 has no hands-free mode (`wake-word-check`, `receptionist-hands-free`,
 * `hands-free-tuning`); it loses nothing else.
 *
 * v7 asks whether a clip is "control" alone rather than whether it starts
 * with it, so this build's wake-word check ("starts with") triggers it on more
 * than it expects; and it never asks for an end phrase. Nothing else differs.
 *
 * v8 never asks whether the speaker has finished (`dictation-turn-check`), so
 * its hands-free dictations end on silence alone; it loses nothing else.
 *
 * v9 has no Control transcript (`receptionist-transcript`, `receptionist-say`,
 * `receptionist-transcript-appended`); it loses nothing else.
 *
 * v10 never sends the phone's audio and lifecycle record (`mobile-events`); it
 * loses nothing else.
 *
 * v11 asks for a hands-free end phrase (`endPhrase`, "over and out") that this
 * build no longer listens for, so its hands-free dictations end only on a
 * pause; it loses nothing else.
 *
 * v12 cannot draw Control's reasoning (`trace` transcript entries), so it is
 * never sent them; it loses nothing else.
 *
 * v13 cannot mute Control or replay its words, and never reports what it has
 * read (`receptionist-hold`, `-read`, `-replay`, `-catch-up`); it is never sent
 * `consumed` transcript entries, which it would draw as broken replies. It
 * loses nothing else.
 *
 * v14 reports a part of a reply read once it has been on screen a second
 * (`receptionist-read`), which this build ignores; it cannot mark where the
 * user stopped taking Control in (`receptionist-mark`, `-read-all`), and is
 * never sent how far Control's voice has got (`receptionist-speaking`). It
 * loses nothing else.
 *
 * v15 expects `receptionist-hold` `mute` to take Control as well, which it no
 * longer does: holding and muting are independent (`take`, `unmute`). It
 * offers Mute only while it already holds Control, so it loses nothing.
 *
 * v16 still has Summary Chat, which this build does not: its chord and its
 * talk button's follow-ups (`summary-chat-toggle`, `-follow-up`, `-end`) and
 * its Control button's `receptionist-select` are answered with a
 * `server-error`, and a chord press waits on a reply that never comes. It
 * reads a missing `target` in `receptionist-status` as the voice having gone
 * to Summary Chat. Its dictation that pastes into nothing is lost; typing to
 * Control, hands-free and the transcript work as before.
 */
export const MIN_CLIENT_PROTOCOL_VERSION = 2
