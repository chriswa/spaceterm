/*
 * Imports nothing, deliberately: the phone's page (src/mobile/dictation.ts)
 * reads this as a value, and `protocol.ts` imports Node's `path` and `os`,
 * which break the browser build of anything that takes a value from it.
 */

/**
 * How long the server keeps a dictation whose client has disconnected, for it
 * to come back and carry on (`dictation-resume`); and how long a finished
 * one's result is kept, for a client whose reply was lost. The phone's
 * finish waits as long for its connection.
 */
export const DICTATION_RESUME_GRACE_MS = 30_000
