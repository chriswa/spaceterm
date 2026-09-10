import * as fs from 'fs'
import { basename } from 'path'
import type { StateManager } from './state-manager'
import type { FileContentManager } from './file-content-manager'
import {
  scanAgentMeta,
  hasAgentMeta,
  REAL_META_SCAN_IO,
  type MetaScan,
  type MetaScanIO,
  type MetaHostKind
} from './agent-meta-scan'
import { resolveFilePath } from './path-utils'
import {
  META_COLUMN_PITCH,
  META_DOC_COLLAPSED_HEIGHT,
  META_DOC_WIDTH,
  META_GROUP_DROP
} from '../shared/node-size'
import type { MetaDocNodeData, MetaGroupNodeData, MetaHostEntry, NodeData } from '../shared/state'
import { asNodeId, ROOT_NODE_ID, type NodeId } from '../shared/ids'
import { serverLog } from './server-log'

const RESCAN_DEBOUNCE_MS = 250

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void

export interface DirWatchHandle {
  close(): void
}

/**
 * What the manager reaches outside itself: a filesystem to scan, a way to watch
 * a directory tree, and a timer. Injected so the interesting behaviour — what a
 * rescan keeps, what it drops, and what enable/disable leave behind — is
 * testable without a real tree or real watch latency.
 */
export interface AgentMetaDeps {
  scanIO: MetaScanIO
  /** Watch a tree for structural change. Null when the path cannot be watched. */
  watchDir(path: string, onChange: () => void): DirWatchHandle | null
  scheduleTimeout(fn: () => void, ms: number): CancelScheduled
  now(): number
}

export const REAL_AGENT_META_DEPS: AgentMetaDeps = {
  scanIO: REAL_META_SCAN_IO,
  watchDir(path, onChange) {
    // Recursive where the platform allows it: a skill's SKILL.md is one level
    // below the root, so a non-recursive watch misses a skill being added into
    // a directory that already existed. Node supports recursive watches on
    // macOS and Windows natively and on Linux since v20; where it throws, the
    // non-recursive watch still catches the common case of a whole skill
    // directory appearing or disappearing.
    try {
      const watcher = fs.watch(path, { recursive: true }, () => onChange())
      watcher.on('error', () => {})
      return { close: () => watcher.close() }
    } catch {
      try {
        const watcher = fs.watch(path, () => onChange())
        watcher.on('error', () => {})
        return { close: () => watcher.close() }
      } catch {
        return null
      }
    }
  },
  scheduleTimeout(fn, ms) {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
  now: () => Date.now()
}

/** Everything the manager holds for one enabled host. */
interface LiveBranch {
  hostId: NodeId
  /** Absolute, `~`-expanded directory the scan runs against. */
  rootDir: string
  kind: MetaHostKind
  /**
   * Group cards on the canvas, keyed by what they head — `meta`, `skills`,
   * `market`, `plugin:<name>`, `plugin:<name>:skills`. A map rather than named
   * fields because a marketplace's plugins appear and disappear like any other
   * scanned thing, and a rescan has to diff them.
   */
  groupIds: Map<string, NodeId>
  docIds: Map<string, NodeId>
  watchers: DirWatchHandle[]
  cancelRescan: CancelScheduled | null
  /**
   * Paths this branch wrote to itself, and when.
   *
   * The write-back path edits files inside the tree the watcher is watching, so
   * without this every pause in typing would fire a rescan. Same idea as
   * `FileContentManager`'s per-entry echo suppression, one level up.
   */
  selfWrites: Map<string, number>
}

/** One group the scan says should exist, and what it hangs under. */
interface WantedGroup {
  kind: 'meta' | 'skills' | 'marketplace' | 'plugin'
  label: string
  sourcePath: string
  /** The group key this hangs under, or null for the branch root (the host). */
  parentKey: string | null
}

interface WantedDoc {
  path: string
  groupKey: string
  kind: 'skill' | 'doc'
}

/**
 * Groups ordered parents-first, so a child is always placed after the parent it
 * is positioned relative to. Depth is short and bounded — meta, market, plugin,
 * skills — so counting hops is cheaper and clearer than a topological sort.
 */
function orderedByDepth(groups: Map<string, WantedGroup>): Array<[string, WantedGroup]> {
  const depth = (key: string): number => {
    let hops = 0
    let current = groups.get(key)?.parentKey ?? null
    while (current !== null && hops < 8) {
      hops++
      current = groups.get(current)?.parentKey ?? null
    }
    return hops
  }
  return [...groups].sort((a, b) => depth(a[0]) - depth(b[0]))
}

/** How long a self-write suppresses the rescan it would otherwise trigger. */
const SELF_WRITE_GRACE_MS = 1500

/**
 * Materialises and reaps the agent-meta branch for each host that has one open.
 *
 * The branch is a *view*: nothing here is authored, so nothing here is
 * persisted beyond the fact that it is open and where the user dragged its
 * cards. Everything else is re-derived from disk, which is what lets a rescan
 * be a diff rather than a rebuild — cards whose key is unchanged are left
 * completely alone, so their positions and their expanded/collapsed state
 * survive a skill being added next to them.
 */
export class AgentMetaManager {
  private branches = new Map<NodeId, LiveBranch>()

  constructor(
    private readonly state: StateManager,
    private readonly files: FileContentManager,
    private readonly deps: AgentMetaDeps = REAL_AGENT_META_DEPS
  ) {
    // Remembering a dragged card's position is the manager's business, not the
    // StateManager's: the key is what the card shows, which only this knows.
    this.state.onEphemeralMove = (nodeId, x, y) => this.rememberPosition(nodeId, x, y)
  }

  // --- Host identity ---

  /**
   * Where a host's documents live, absolute and `~`-expanded.
   *
   * Directory nodes store their cwd abbreviated (`abbreviateCwd`), so the
   * common case under `$HOME` is `~/spaceterm`. Expanding here rather than in
   * the scanner keeps the scanner pure and keeps this the only place that has
   * to know the field is abbreviated.
   */
  private hostDir(hostId: NodeId): { dir: string; kind: MetaHostKind } | null {
    if (hostId === ROOT_NODE_ID) {
      return { dir: resolveFilePath('~/.claude'), kind: 'user' }
    }
    const node = this.state.getNode(hostId)
    if (!node || node.type !== 'directory') return null
    return { dir: resolveFilePath(node.cwd), kind: 'project' }
  }

  /** Whether a host has anything worth showing. Used by the availability probe. */
  scanFor(hostId: NodeId): MetaScan | null {
    const host = this.hostDir(hostId)
    if (!host) return null
    return scanAgentMeta(host.dir, host.kind, this.deps.scanIO)
  }

  isEnabled(hostId: NodeId): boolean {
    return this.branches.has(hostId)
  }

  // --- Lifecycle ---

  /** Open a host's branch. Returns false when there is nothing to show. */
  enable(hostId: NodeId): boolean {
    if (this.branches.has(hostId)) return true
    const host = this.hostDir(hostId)
    if (!host) return false
    const scan = scanAgentMeta(host.dir, host.kind, this.deps.scanIO)
    if (!hasAgentMeta(scan)) return false

    const branch: LiveBranch = {
      hostId,
      rootDir: host.dir,
      kind: host.kind,
      groupIds: new Map(),
      docIds: new Map(),
      watchers: [],
      cancelRescan: null,
      selfWrites: new Map()
    }
    this.branches.set(hostId, branch)
    // Record it as open before building, so a crash mid-build still reopens.
    // Any remembered layout is kept — the entry outlives the branch.
    this.state.setMetaHost(hostId, { ...this.state.getMetaHost(hostId), open: true })

    this.materialise(branch, scan)
    this.startWatching(branch, scan)
    serverLog(`[agent-meta] Opened branch for ${hostId} at ${host.dir}`)
    return true
  }

  /** Close a host's branch, taking every card with it. */
  disable(hostId: NodeId): void {
    const branch = this.branches.get(hostId)
    if (branch) {
      this.teardown(branch)
      this.branches.delete(hostId)
    }
    this.markClosed(hostId)
    serverLog(`[agent-meta] Closed branch for ${hostId}`)
  }

  /** Toggle, reporting whether the branch is open afterwards. */
  toggle(hostId: NodeId): boolean {
    if (this.branches.has(hostId)) {
      this.disable(hostId)
      return false
    }
    return this.enable(hostId)
  }

  /** The host's directory changed underneath it: rebuild against the new path. */
  onHostChanged(hostId: NodeId): void {
    if (!this.branches.has(hostId)) return
    const remembered = this.state.getMetaHost(hostId)
    this.disable(hostId)
    // The group keeps its place, but the per-card layout does not follow a
    // directory node to a different repo: two repos routinely ship a skill
    // with the same name, and it would land where the other one's sat.
    this.state.setMetaHost(hostId, { open: false, groupPos: remembered?.groupPos })
    this.enable(hostId)
  }

  /**
   * The host left the canvas, so its layout has nothing left to describe.
   * Unlike closing the branch, this forgets the positions too.
   */
  onHostRemoved(hostId: NodeId): void {
    const branch = this.branches.get(hostId)
    if (branch) {
      this.teardown(branch)
      this.branches.delete(hostId)
    }
    this.state.clearMetaHost(hostId)
  }

  /** Reopen every branch recorded as open, at startup. */
  restoreFromState(): void {
    for (const [hostId, entry] of Object.entries(this.state.getMetaHosts())) {
      const id = asNodeId(hostId)
      if (id !== ROOT_NODE_ID && !this.state.getNode(id)) {
        // Its host was archived while the server was down.
        this.state.clearMetaHost(id)
        continue
      }
      if (!entry.open) continue
      if (!this.enable(id)) this.markClosed(id)
    }
  }

  dispose(): void {
    for (const branch of this.branches.values()) this.teardown(branch)
    this.branches.clear()
  }

  // --- Rescan ---

  /** Re-read the tree and apply the difference. Cheap when nothing changed. */
  rescan(hostId: NodeId): void {
    const branch = this.branches.get(hostId)
    if (!branch) return
    const scan = scanAgentMeta(branch.rootDir, branch.kind, this.deps.scanIO)
    if (!hasAgentMeta(scan)) {
      // Everything it was showing is gone. Closing is more honest than an
      // empty group card that cannot say why it is empty.
      this.disable(hostId)
      return
    }
    this.materialise(branch, scan)
  }

  /** Note a write this branch made, so the watcher does not read it as a change. */
  noteSelfWrite(nodeId: NodeId): void {
    const node = this.state.getNode(nodeId)
    if (!node || node.type !== 'meta-doc') return
    const branch = this.branches.get(node.hostId)
    if (branch) branch.selfWrites.set(node.docPath, this.deps.now())
  }

  private startWatching(branch: LiveBranch, scan: MetaScan): void {
    const roots = new Set<string>()
    if (scan.skillsRoot) roots.add(scan.skillsRoot)
    // Watch the host directory too, so a CLAUDE.md appearing or vanishing is
    // noticed even when there are no skills at all.
    roots.add(branch.rootDir)

    for (const root of roots) {
      const handle = this.deps.watchDir(root, () => this.onWatchEvent(branch))
      if (handle) branch.watchers.push(handle)
    }
  }

  private onWatchEvent(branch: LiveBranch): void {
    const now = this.deps.now()
    // Drop stale suppressions so the map cannot grow across a long session.
    for (const [path, at] of branch.selfWrites) {
      if (now - at > SELF_WRITE_GRACE_MS) branch.selfWrites.delete(path)
    }
    if (branch.selfWrites.size > 0) return

    branch.cancelRescan?.()
    branch.cancelRescan = this.deps.scheduleTimeout(() => {
      branch.cancelRescan = null
      this.rescan(branch.hostId)
    }, RESCAN_DEBOUNCE_MS)
  }

  // --- Building ---

  /**
   * Bring the canvas into line with one scan.
   *
   * A diff rather than a rebuild. Keys that survive keep their node — and so
   * keep their position, their measured size and, on the client, whether they
   * are expanded — while keys that appeared get a card and keys that went get
   * theirs removed along with its file watch.
   */
  private materialise(branch: LiveBranch, scan: MetaScan): void {
    // What the canvas SHOULD show, built first and diffed second. Groups are
    // keyed by what they head and carry the key of the group they hang under,
    // so the shape below is a tree without any of this code recursing.
    const wantedGroups = new Map<string, WantedGroup>()
    const wantedDocs = new Map<string, WantedDoc>()

    wantedGroups.set('meta', {
      kind: 'meta',
      label: 'Agent Meta',
      sourcePath: branch.rootDir,
      parentKey: null
    })
    for (const doc of scan.docs) {
      wantedDocs.set(doc.key, { path: doc.path, groupKey: 'meta', kind: 'doc' })
    }
    if (scan.skills.length > 0) {
      wantedGroups.set('skills', {
        kind: 'skills',
        label: `Skills · ${scan.skills.length}`,
        sourcePath: scan.skillsRoot ?? branch.rootDir,
        parentKey: 'meta'
      })
      for (const skill of scan.skills) {
        wantedDocs.set(skill.key, { path: skill.path, groupKey: 'skills', kind: 'skill' })
      }
    }

    // A marketplace hangs beside the host's own documents, not instead of them.
    const marketplace = scan.marketplace
    if (marketplace) {
      wantedGroups.set('market', {
        kind: 'marketplace',
        label: `Marketplace · ${marketplace.name}`,
        sourcePath: marketplace.dir,
        parentKey: 'meta'
      })
      for (const plugin of marketplace.plugins) {
        const pluginKey = `plugin:${plugin.name}`
        wantedGroups.set(pluginKey, {
          kind: 'plugin',
          label: plugin.name,
          sourcePath: plugin.dir,
          parentKey: 'market'
        })
        for (const doc of plugin.docs) {
          wantedDocs.set(doc.key, { path: doc.path, groupKey: pluginKey, kind: 'doc' })
        }
        if (plugin.skills.length > 0) {
          const pluginSkillsKey = `${pluginKey}:skills`
          wantedGroups.set(pluginSkillsKey, {
            kind: 'skills',
            label: `Skills · ${plugin.skills.length}`,
            sourcePath: plugin.skillsRoot ?? plugin.dir,
            parentKey: pluginKey
          })
          for (const skill of plugin.skills) {
            wantedDocs.set(skill.key, { path: skill.path, groupKey: pluginSkillsKey, kind: 'skill' })
          }
        }
      }
    }

    // --- Drop what is no longer wanted, cards before the groups they hung on.
    for (const [key, nodeId] of [...branch.docIds]) {
      if (wantedDocs.has(key)) continue
      this.files.stopWatching(nodeId)
      this.removeNode(nodeId)
      branch.docIds.delete(key)
    }
    for (const [key, nodeId] of [...branch.groupIds]) {
      if (wantedGroups.has(key)) continue
      this.removeNode(nodeId)
      branch.groupIds.delete(key)
    }

    // --- Groups, parents before children so a child can be placed beside one.
    const slotOf = new Map<string, number>()
    for (const [key, want] of orderedByDepth(wantedGroups)) {
      const parentNodeId = want.parentKey === null
        ? branch.hostId
        : branch.groupIds.get(want.parentKey) ?? branch.hostId
      const slot = slotOf.get(want.parentKey ?? '') ?? 0
      slotOf.set(want.parentKey ?? '', slot + 1)
      this.ensureGroup(branch, key, want, parentNodeId, slot)
    }

    // --- Cards, into whichever group now holds them.
    const entry: MetaHostEntry = this.state.getMetaHost(branch.hostId) ?? { open: true }
    const cardSlot = new Map<string, number>()
    for (const [key, want] of wantedDocs) {
      const groupNodeId = branch.groupIds.get(want.groupKey)
      if (!groupNodeId) continue
      const slot = cardSlot.get(want.groupKey) ?? 0
      cardSlot.set(want.groupKey, slot + 1)

      const existing = branch.docIds.get(key)
      if (existing) {
        const node = this.state.getNode(existing)
        if (node?.type === 'meta-doc' && node.parentId !== groupNodeId) {
          this.state.patchEphemeralNode(existing, { parentId: groupNodeId })
        }
        continue
      }

      const pos = entry.cardPos?.[key] ?? this.slotPosition(groupNodeId, slot)
      const id = docNodeId(branch.hostId, key)
      const node: MetaDocNodeData = {
        id,
        type: 'meta-doc',
        parentId: groupNodeId,
        hostId: branch.hostId,
        docKind: want.kind,
        docKey: key,
        docPath: want.path,
        x: pos.x,
        y: pos.y,
        zIndex: 0,
        width: META_DOC_WIDTH,
        height: META_DOC_COLLAPSED_HEIGHT,
        archivedChildren: [],
        // Without this `dim-stale` reads undefined as the oldest band and
        // renders every generated card permanently dimmed.
        lastInteractedAt: this.deps.now()
      }
      this.state.addEphemeralNode(node)
      branch.docIds.set(key, id)
      // `createIfMissing: false` — a scan-driven flow must never bring a file
      // back. A skill deleted inside the debounce window would otherwise have
      // its directory and an empty SKILL.md recreated in the user's repo, and
      // the watcher would then see a legitimate new skill.
      this.files.startWatching(id, groupNodeId, want.path, { createIfMissing: false })
    }

    // Keep the remembered positions to what the scan actually found, so the map
    // cannot grow without bound.
    this.prunePositions(branch, [...wantedDocs.keys()])
  }

  private ensureGroup(
    branch: LiveBranch,
    key: string,
    want: WantedGroup,
    parentNodeId: NodeId,
    slot: number
  ): void {
    const id = groupNodeId(branch.hostId, key)
    const existing = this.state.getNode(id)
    if (existing && existing.type === 'meta-group') {
      branch.groupIds.set(key, id)
      const patch: Partial<MetaGroupNodeData> = {}
      if (existing.label !== want.label) patch.label = want.label
      if (existing.sourcePath !== want.sourcePath) patch.sourcePath = want.sourcePath
      if (existing.parentId !== parentNodeId) patch.parentId = parentNodeId
      if (Object.keys(patch).length > 0) this.state.patchEphemeralNode(id, patch)
      return
    }

    // Only the branch root's position is remembered: everything below it is
    // laid out relative to its parent, so restoring one nested group to an
    // absolute position it held under a different tree shape would scatter it.
    const remembered = key === 'meta' ? this.state.getMetaHost(branch.hostId)?.groupPos : undefined
    const pos = remembered ?? this.groupPosition(parentNodeId, slot)
    const node: MetaGroupNodeData = {
      id,
      type: 'meta-group',
      parentId: parentNodeId,
      hostId: branch.hostId,
      groupKind: want.kind,
      label: want.label,
      sourcePath: want.sourcePath,
      x: pos.x,
      y: pos.y,
      zIndex: 0,
      archivedChildren: [],
      lastInteractedAt: this.deps.now()
    }
    this.state.addEphemeralNode(node)
    branch.groupIds.set(key, id)
  }

  /** A group sits below its parent, fanned sideways so siblings do not stack. */
  private groupPosition(parentNodeId: NodeId, slot: number): { x: number; y: number } {
    const parent = parentNodeId === ROOT_NODE_ID ? null : this.state.getNode(parentNodeId)
    const base = parent ?? { x: 0, y: 0 }
    return { x: base.x + slot * (META_DOC_WIDTH + 120), y: base.y + META_GROUP_DROP }
  }

  /** A column below the group, so a set of cards reads as the list it is. */
  private slotPosition(groupNodeId: NodeId, slot: number): { x: number; y: number } {
    const group = this.state.getNode(groupNodeId)
    const base = group ?? { x: 0, y: 0 }
    return { x: base.x, y: base.y + META_GROUP_DROP + slot * META_COLUMN_PITCH }
  }

  // --- Position memory ---

  private rememberPosition(nodeId: NodeId, x: number, y: number): void {
    const node = this.state.getNode(nodeId)
    if (!node) return
    if (node.type === 'meta-group') {
      // Only the branch root. A nested group's place is derived from its
      // parent, so remembering an absolute position for one would misplace it
      // the moment the tree above it changed shape.
      if (node.groupKind !== 'meta') return
      const entry: MetaHostEntry = this.state.getMetaHost(node.hostId) ?? { open: true }
      this.state.setMetaHost(node.hostId, { ...entry, groupPos: { x, y } })
      return
    }
    if (node.type !== 'meta-doc') return
    const entry: MetaHostEntry = this.state.getMetaHost(node.hostId) ?? { open: true }
    this.state.setMetaHost(node.hostId, {
      ...entry,
      cardPos: { ...entry.cardPos, [node.docKey]: { x, y } }
    })
  }

  private prunePositions(branch: LiveBranch, keys: string[]): void {
    const entry = this.state.getMetaHost(branch.hostId)
    if (!entry?.cardPos) return
    const live = new Set(keys)
    const kept: Record<string, { x: number; y: number }> = {}
    let dropped = false
    for (const [key, pos] of Object.entries(entry.cardPos)) {
      if (live.has(key)) kept[key] = pos
      else dropped = true
    }
    if (dropped) this.state.setMetaHost(branch.hostId, { ...entry, cardPos: kept })
  }

  // --- Teardown ---

  private teardown(branch: LiveBranch): void {
    branch.cancelRescan?.()
    branch.cancelRescan = null
    for (const watcher of branch.watchers) watcher.close()
    branch.watchers = []
    for (const nodeId of branch.docIds.values()) {
      this.files.stopWatching(nodeId)
      this.removeNode(nodeId)
    }
    branch.docIds.clear()
    for (const nodeId of branch.groupIds.values()) this.removeNode(nodeId)
    branch.groupIds.clear()
  }

  private removeNode(nodeId: NodeId): void {
    this.state.removeEphemeralNode(nodeId)
  }

  /**
   * Mark a branch closed, keeping any layout worth keeping.
   *
   * An entry with nothing remembered is dropped outright rather than left as a
   * tombstone, so a host that was opened once and closed leaves the document
   * exactly as it found it.
   */
  private markClosed(hostId: NodeId): void {
    const entry = this.state.getMetaHost(hostId)
    if (!entry) return
    const remembersSomething = entry.groupPos !== undefined || Object.keys(entry.cardPos ?? {}).length > 0
    if (remembersSomething) this.state.setMetaHost(hostId, { ...entry, open: false })
    else this.state.clearMetaHost(hostId)
  }
}

/**
 * Deterministic ids, so a card keeps its identity across a server restart.
 *
 * Not for persistence — none of these nodes is written down — but for identity:
 * deep-link focus, camera history and the renderer's expanded-card set are all
 * keyed by node id, and a fresh uuid every boot would quietly reset all three.
 */
export function metaGroupId(hostId: NodeId): NodeId {
  return groupNodeId(hostId, 'meta')
}

/** `meta`, `skills`, `market`, `plugin:<name>`, `plugin:<name>:skills`. */
export function groupNodeId(hostId: NodeId, groupKey: string): NodeId {
  return asNodeId(`meta:${hostId}:group:${groupKey}`)
}

export function docNodeId(hostId: NodeId, key: string): NodeId {
  return asNodeId(`meta:${hostId}:doc:${key}`)
}

/** The caption a card falls back to when its document offers no title. */
export function docFallbackName(node: NodeData): string {
  if (node.type !== 'meta-doc') return ''
  return node.docKind === 'skill' ? node.docKey : basename(node.docPath)
}

export type { MetaHostEntry }
