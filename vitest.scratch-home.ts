import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Points `SPACETERM_HOME` at a throwaway directory for the whole run, so a test
 * can never write into the user's real `~/.spaceterm`. Without it, every
 * `serverLog` a suite triggers lands in the live `electron.log`, interleaved
 * with the running app's entries — a receptionist test's scripted "safeguards
 * flagged this message" reads exactly like a real failure there.
 *
 * Set here, before any worker starts, because `SOCKET_DIR` is read once at
 * module load (src/shared/protocol.ts) and workers inherit this environment.
 */
export default function setup(): () => void {
  const home = mkdtempSync(join(tmpdir(), 'spaceterm-test-home-'))
  process.env.SPACETERM_HOME = home
  return () => rmSync(home, { recursive: true, force: true })
}
