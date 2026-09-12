import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'
import * as logger from './logger'
import { parsePsOutput, sumDescendantRss } from './ps-tree'

const execFileAsync = promisify(execFile)

/**
 * How much memory the agents are using, for the toolbar's readout.
 *
 * Every PTY Spaceterm runs is a child of the pty-daemon — that is the whole
 * point of the daemon — so "all running agents" is exactly "the daemon's
 * descendants". Nothing has to be tracked as sessions come and go: the process
 * tree already knows, and it stays right across a server restart that the
 * daemon outlived.
 *
 * Deliberately not part of `system-metrics.ts`. That sampler is opt-in
 * scaffolding for the power monitor and is off by default; this is always-on
 * toolbar furniture, and one `ps` per second should not require switching a
 * `ioreg` pair on alongside it.
 *
 * The path resolution matches `SOCKET_DIR` in `src/shared/protocol.ts`. It is
 * duplicated rather than imported because that module is the server↔client
 * protocol and pulls in the rest of it; the rule is two lines and has never
 * changed.
 */

const DAEMON_PID_FILE = join(process.env.SPACETERM_HOME ?? join(homedir(), '.spaceterm'), 'pty-daemon.pid')

async function readDaemonPid(): Promise<number | null> {
  try {
    const pid = Number((await readFile(DAEMON_PID_FILE, 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    // No pidfile means no daemon, which is a normal state, not an error.
    return null
  }
}

/**
 * Total resident memory of every process under the PTY daemon, in bytes.
 *
 * `null` when there is no daemon to ask about — which the toolbar renders as a
 * dash rather than as zero, since "no agents" and "no daemon" are different
 * things to be looking at.
 */
export async function readAgentMemoryBytes(): Promise<number | null> {
  const daemonPid = await readDaemonPid()
  if (daemonPid === null) return null
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 8 * 1024 * 1024 })
    return sumDescendantRss(parsePsOutput(stdout), daemonPid)
  } catch (err: unknown) {
    logger.log('[agent-memory] ps failed: ' + (err instanceof Error ? err.message : String(err)))
    return null
  }
}
