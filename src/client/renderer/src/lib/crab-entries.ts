import type { NodeData } from '../../../../shared/state'
import { isCacheTimerMuted } from '../../../../shared/state'
import { deriveToolbarIndicator, type CrabEntry } from './crab-nav'
import { modelHat } from './model-hat'
import { crabEffortSteps } from './crab-effort'
import { nodeDisplayTitle } from './node-title'

/**
 * Every terminal surface as a crab, in the operator's toolbar order. The
 * desktop toolbar and the phone's surface list both draw from this, so the two
 * can never disagree about a surface's colour, hat or position.
 */
export function deriveCrabs(nodes: Record<string, NodeData>): CrabEntry[] {
  const entries: CrabEntry[] = []
  for (const node of Object.values(nodes)) {
    if (node.type !== 'terminal') continue
    const appearance = deriveToolbarIndicator(node.claudeState, node.claudeStatusUnread, node.claudeStatusAsleep ?? false, node.claudeSessionHistory.length > 0, node.agentType)
    const createdAt = node.terminalSessions[0]?.startedAt ?? ''
    entries.push({ nodeId: node.id, claudeSessionIds: node.claudeSessionHistory.map(e => e.claudeSessionId), kind: appearance.kind, color: appearance.color, hat: modelHat(appearance.kind, node.claudeModel), effortSteps: crabEffortSteps(appearance.kind, node.claudeEffort), unviewed: appearance.unviewed, asleep: appearance.asleep, createdAt, sortOrder: node.sortOrder, title: nodeDisplayTitle(node), claudeStateDecidedAt: node.claudeStateDecidedAt, cacheWarmUntil: isCacheTimerMuted(node) ? undefined : node.cacheWarmUntil, cacheWarmEstimated: node.cacheWarmEstimated })
  }
  entries.sort((a, b) => a.sortOrder - b.sortOrder)
  return entries
}
