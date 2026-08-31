#!/usr/bin/env tsx
/**
 * flag-restart — raise the "Spaceterm server needs a restart" signal.
 *
 * Usage:
 *   npm run flag-restart -- "why a restart is needed"
 *
 * Writes ~/.spaceterm/restart-required.json. The running server watches for it
 * and lights up the client's ↻ Restart button with a marching-ants border, so
 * the human sees that on-disk changes (CLAUDE.md, server code, protocol, …) need
 * a restart to take effect. A fresh server clears the flag on startup.
 *
 * Agents: raise this instead of restarting the server yourself — the restart is
 * the human's call.
 */
import { writeRestartFlag, restartFlagPath } from '../server/restart-flag'

const reason = process.argv.slice(2).join(' ').trim()
writeRestartFlag(reason)

console.log(`Flagged a Spaceterm server restart${reason ? `: ${reason}` : ''}`)
console.log(`Wrote ${restartFlagPath()}`)
console.log('The ↻ Restart button in the client will now animate until the server restarts.')
