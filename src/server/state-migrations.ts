import type { ServerState, TerminalNodeData } from '../shared/state'

/**
 * Bump this when a migration is added below.
 *
 * Version 1 was written into every state file from the beginning and never read
 * back, so "version 1" on disk describes a range of shapes rather than one: it
 * covers every file written before this module existed, whether or not it has
 * `savedViewports`, `sortOrder`, or the long-removed `waitingForUser`. Migration
 * 1 → 2 therefore normalises defensively instead of assuming a known shape. From
 * version 2 on, the number means what it says.
 */
export const CURRENT_STATE_VERSION = 2

/** A persisted document as it comes off disk: shape unknown until migrated. */
export type PersistedDoc = Record<string, unknown>

export interface Migration {
  /** The version this migration produces. */
  to: number
  /** Shown in the startup log so an unexpected migration is visible. */
  description: string
  /** Mutates `doc` in place. Must tolerate any shape a prior version could produce. */
  migrate(doc: PersistedDoc): void
}

export type MigrationResult =
  | { status: 'ok'; state: ServerState; migratedFrom: number | null }
  /** Nothing persisted yet — a first run. */
  | { status: 'empty' }
  /** Present but unusable. The caller should preserve the file, not overwrite it. */
  | { status: 'corrupt'; reason: string }
  /** Written by a newer build. Loading it would silently drop fields we cannot see. */
  | { status: 'too-new'; found: number; supported: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Terminal nodes in a doc, as loosely-typed records. */
function terminalNodes(doc: PersistedDoc): Array<Record<string, unknown>> {
  const nodes = doc.nodes
  if (!isRecord(nodes)) return []
  return Object.values(nodes).filter(
    (n): n is Record<string, unknown> => isRecord(n) && n.type === 'terminal'
  )
}

export const MIGRATIONS: Migration[] = [
  {
    to: 2,
    description:
      'normalise fields that accumulated as ad-hoc backfills while the version number went unused',
    migrate(doc) {
      // Top-level fields added over time. Each was previously backfilled in the
      // StateManager constructor on every single boot.
      if (!Array.isArray(doc.rootArchivedChildren)) doc.rootArchivedChildren = []
      if (!Array.isArray(doc.undoBuffer)) doc.undoBuffer = []
      if (typeof doc.undoCursor !== 'number') {
        doc.undoCursor = (doc.undoBuffer as unknown[]).length
      }
      if (!isRecord(doc.savedViewports)) doc.savedViewports = {}
      if (typeof doc.nextZIndex !== 'number') doc.nextZIndex = 1
      if (!isRecord(doc.nodes)) doc.nodes = {}

      const terminals = terminalNodes(doc)

      for (const node of terminals) {
        // Removed key from an older claude-state model.
        delete node.waitingForUser
        if (typeof node.claudeStatusUnread !== 'boolean') node.claudeStatusUnread = false
        if (typeof node.claudeStatusAsleep !== 'boolean') node.claudeStatusAsleep = false
      }

      // Backfill sortOrder, preserving the order terminals were created in.
      let maxSortOrder = -1
      for (const node of terminals) {
        if (typeof node.sortOrder === 'number' && node.sortOrder > maxSortOrder) {
          maxSortOrder = node.sortOrder
        }
      }
      const needsSortOrder = terminals.filter((n) => typeof n.sortOrder !== 'number')
      needsSortOrder.sort((a, b) => {
        const startedAt = (n: Record<string, unknown>): string => {
          const sessions = n.terminalSessions
          if (!Array.isArray(sessions) || sessions.length === 0) return ''
          const first = sessions[0]
          return isRecord(first) && typeof first.startedAt === 'string' ? first.startedAt : ''
        }
        const aTime = startedAt(a)
        const bTime = startedAt(b)
        return aTime < bTime ? -1 : aTime > bTime ? 1 : 0
      })
      for (const node of needsSortOrder) {
        node.sortOrder = ++maxSortOrder
      }

      // One-time alert wipe: alerts recorded before the `~` expansion fix hold
      // paths that were never real, so every one of them is a false positive.
      // This used to run on every boot from a block marked `// TEMPORARY:`,
      // because without a version number there was no way to say "once".
      const nodes = doc.nodes as Record<string, unknown>
      for (const node of Object.values(nodes)) {
        if (!isRecord(node)) continue
        delete node.alerts
        delete node.alertsReadTimestamp
      }
    }
  }
]

/**
 * Bring a persisted document up to `CURRENT_STATE_VERSION`.
 *
 * Migrations run in order from the document's version. The document is mutated
 * in place; callers that care about the original should pass a copy.
 */
export function migrateState(raw: unknown): MigrationResult {
  if (raw === null || raw === undefined) return { status: 'empty' }
  if (!isRecord(raw)) return { status: 'corrupt', reason: 'not an object' }

  const version = raw.version
  if (typeof version !== 'number') return { status: 'corrupt', reason: 'missing version' }
  if (!isRecord(raw.nodes)) return { status: 'corrupt', reason: 'missing nodes' }

  if (version > CURRENT_STATE_VERSION) {
    return { status: 'too-new', found: version, supported: CURRENT_STATE_VERSION }
  }

  const pending = MIGRATIONS.filter((m) => m.to > version).sort((a, b) => a.to - b.to)
  for (const migration of pending) {
    migration.migrate(raw)
    raw.version = migration.to
  }
  raw.version = CURRENT_STATE_VERSION

  return {
    status: 'ok',
    state: raw as unknown as ServerState,
    migratedFrom: pending.length > 0 ? version : null
  }
}

/** Convenience for tests and for the first-run path. */
export function emptyState(): ServerState {
  return {
    version: CURRENT_STATE_VERSION,
    nextZIndex: 1,
    nodes: {},
    rootArchivedChildren: [],
    undoBuffer: [],
    undoCursor: 0,
    savedViewports: {}
  }
}

/** Narrow a node record to a terminal, for callers walking a migrated state. */
export function isTerminal(node: unknown): node is TerminalNodeData {
  return isRecord(node) && node.type === 'terminal'
}
