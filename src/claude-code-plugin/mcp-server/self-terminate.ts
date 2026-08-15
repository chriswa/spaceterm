import { execFileSync } from 'child_process'
import * as path from 'path'
import { z } from 'zod'
import { defineTool } from './stdio-mcp.js'
import { AGENT_PTY_COMMANDS } from '../../shared/agent-type.js'

/** `comm` values that identify an agent CLI, from the names the drivers launch. */
const AGENT_COMMANDS = new Set<string>(Object.values(AGENT_PTY_COMMANDS))

/**
 * Every surface's PTY is spawned by the pty daemon, so its `comm` marks the
 * edge of this surface. Stopping there is what keeps a self-terminate from
 * reaching the daemon, the spaceterm server, or another surface entirely.
 */
const PTY_DAEMON_COMMAND = 'pty-daemon'

/** Deep enough for a shell, a wrapper or two, and the MCP server itself. */
const MAX_ANCESTRY_DEPTH = 12

interface ProcessInfo {
  pid: number
  ppid: number
  /** Basename of the executable, e.g. `claude`. */
  command: string
}

function readProcess(pid: number): ProcessInfo | null {
  let out: string
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=,comm='], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null
  }
  const match = /^(\d+)\s+(.+)$/.exec(out)
  if (!match) return null
  return { pid, ppid: Number(match[1]), command: path.basename(match[2].trim()) }
}

/**
 * The nearest agent CLI at or above this process, searching no further than the
 * pty daemon.
 *
 * One rule covers both surface shapes, because the answer differs by where the
 * agent sits rather than by what the surface is:
 *  - An agent surface runs its CLI as the PTY's top-level process, so the match
 *    is the PTY root — killing it exits the PTY, which archives the surface.
 *  - A plain terminal someone typed `claude` into has a shell at the root, so
 *    the match is that agent instead. The shell survives and the tile stays.
 */
export function findAgentProcess(startPid: number): ProcessInfo | null {
  let pid = startPid
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid > 1; depth++) {
    const info = readProcess(pid)
    if (!info) return null
    if (info.command === PTY_DAEMON_COMMAND) return null
    if (AGENT_COMMANDS.has(info.command)) return info
    pid = info.ppid
  }
  return null
}

export const selfTerminateTool = defineTool({
  name: 'self_terminate',
  description:
    'Terminates the current agent session by sending SIGTERM to the agent CLI running in this ' +
    'spaceterm surface. A surface launched as an agent surface is archived, and can be restored ' +
    'later by un-archiving it; an agent started by hand inside a plain terminal is killed on its ' +
    'own, leaving the terminal open. ' +
    'DANGER: Only use this if explicitly asked to "self terminate". The language must be precise.',
  inputSchema: z.object({}),
  async handler() {
    const agent = findAgentProcess(process.ppid)

    if (!agent) {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              'Error: no agent process found between this MCP server and the pty daemon. ' +
              'This tool only works inside a spaceterm surface.',
          },
        ],
        isError: true,
      }
    }

    // The MCP server is a descendant of the process being signalled, so this
    // result is best-effort — the PTY usually closes before it is delivered.
    process.kill(agent.pid, 'SIGTERM')

    return {
      content: [
        {
          type: 'text' as const,
          text: `Sent SIGTERM to ${agent.command} (PID: ${agent.pid}).`,
        },
      ],
    }
  },
})
