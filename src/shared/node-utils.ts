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
      // A terminal that ever had a Claude session is always worth preserving.
      // This survives reincarnation — the node-level history persists even when
      // the latest TerminalSessionEntry hasn't detected the Claude session yet.
      if (node.claudeSessionHistory.length > 0) return false
      // Also check individual terminal sessions (covers edge cases where
      // claudeSessionHistory wasn't populated but a session was recorded)
      if (node.terminalSessions.some(s => s.claudeSessionId)) return false
      return true // bare terminal with no Claude sessions
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
