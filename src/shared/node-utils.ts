import type { NodeData } from './state'

/**
 * Whether a node should be silently deleted instead of archived.
 * A node is disposable when it has no meaningful user content worth preserving.
 * Critically, a node with archivedChildren is NEVER disposable — deleting it
 * would permanently lose those nested archives.
 */
export function isDisposable(node: NodeData): boolean {
  if (node.archivedChildren.length > 0) return false

  switch (node.type) {
    case 'terminal': {
      const latest = node.terminalSessions[node.terminalSessions.length - 1]
      if (!latest || !latest.claudeSessionId) return true // bare terminal, can't revive
      return latest.shellTitleHistory.length < 1 // no real titles after filtering
    }
    case 'markdown':
      return node.content.trim() === ''
    case 'directory':
      return false
    case 'file':
      return false
    case 'title':
      return node.text.trim() === ''
    default:
      return false
  }
}
