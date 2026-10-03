import type { NodeData, TerminalNodeData } from '../../../../shared/state'
import type { NodeId } from '../../../../shared/ids'
import { isAgentSurface } from '../../../../shared/node-utils'
import { sendTerminalRestart } from './server-sync'

/**
 * Restart every live agent surface, one after another.
 *
 * Deliberately blind to what each surface is doing: a surface mid-turn or
 * running background tasks is restarted anyway, and resumes its session the
 * way the per-surface Extra CLI restart does. The toolbar widget's confirmation
 * is the only guard, which is why it names the cost.
 *
 * Staggered rather than fired at once so a dozen agents are not all booting —
 * loading MCP servers, replaying transcripts — in the same second.
 */

/** Gap between one surface's restart and the next. */
export const ROLLING_RESTART_STAGGER_MS = 1500

/** Live agent surfaces, in no particular order. Remnants are left dead. */
export function restartableAgentSurfaces(nodes: Record<string, NodeData>): TerminalNodeData[] {
  return Object.values(nodes).filter((n): n is TerminalNodeData => isAgentSurface(n) && n.alive)
}

export interface RollingRestartDeps {
  restart(nodeId: NodeId, extraCliArgs: string): Promise<unknown>
  wait(ms: number): Promise<void>
}

export const REAL_ROLLING_RESTART_DEPS: RollingRestartDeps = {
  restart: sendTerminalRestart,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export interface RollingRestartResult {
  restarted: number
  failed: number
}

/**
 * Restart each surface in turn, keeping its current extra CLI args. One
 * surface failing does not stop the rest; the server marks a failed surface
 * with a launch-failed alert, so the count is all the caller needs.
 */
export async function rollingRestart(
  surfaces: readonly TerminalNodeData[],
  onProgress: (done: number, total: number) => void = () => {},
  deps: RollingRestartDeps = REAL_ROLLING_RESTART_DEPS,
): Promise<RollingRestartResult> {
  let restarted = 0
  let failed = 0
  for (const [i, surface] of surfaces.entries()) {
    if (i > 0) await deps.wait(ROLLING_RESTART_STAGGER_MS)
    try {
      await deps.restart(surface.id, surface.extraCliArgs ?? '')
      restarted++
    } catch {
      failed++
    }
    onProgress(i + 1, surfaces.length)
  }
  return { restarted, failed }
}
