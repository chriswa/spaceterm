import { describe, it, expect, beforeEach } from 'vitest'
import { AgentMetaManager, type AgentMetaDeps, type DirWatchHandle } from './agent-meta-manager'
import { StateManager, type StateManagerDeps } from './state-manager'
import { StatePersister, serializeState } from './persistence'
import { FakePersistenceIO } from './testing/fake-persistence'
import { FileContentManager, type FileContentIO } from './file-content-manager'
import type { MetaScanIO } from './agent-meta-scan'
import type { MetaDocNodeData, MetaGroupNodeData, NodeData } from '../shared/state'
import { ROOT_NODE_ID, type NodeId } from '../shared/ids'
import { homedir } from 'os'

/**
 * The branch as a *view*: what a rescan keeps, what it drops, and the promise
 * that opening and closing one leaves nothing behind.
 *
 * Driven against a real `StateManager` with in-memory persistence rather than a
 * mocked one, because the thing worth asserting is what the document looks
 * like, and only the real StateManager decides that.
 */

const HOME = homedir()

/** A mutable literal filesystem, so a test can add and remove skills mid-run. */
function fakeTree(initial: Record<string, string | null>) {
  const tree = { ...initial }
  const scanIO: MetaScanIO = {
    isDirectory: (p) => tree[p] === null,
    isFile: (p) => typeof tree[p] === 'string',
    readFile: (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : undefined),
    readdir: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const names = new Set<string>()
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest !== '') names.add(rest.split('/')[0])
      }
      return [...names]
    }
  }
  return { tree, scanIO }
}

interface Harness {
  sm: StateManager
  manager: AgentMetaManager
  tree: Record<string, string | null>
  /** Files the FileContentManager was asked to create. Must stay empty. */
  created: string[]
  watched: string[]
  fireWatch(): void
  doc(): ReturnType<typeof JSON.parse>
}

function harness(initial: Record<string, string | null>): Harness {
  const io = new FakePersistenceIO()
  const deps: StateManagerDeps = {
    onNodeUpdate: () => {},
    onNodeAdd: () => {},
    onNodeRemove: () => {}
  }
  const sm = new StateManager(deps, { persister: new StatePersister(io, 1000) })

  const { tree, scanIO } = fakeTree(initial)
  const created: string[] = []
  const fileIO: FileContentIO = {
    readFile: (p) => (typeof tree[p] === 'string' ? (tree[p] as string) : undefined),
    writeFile: (p, content) => {
      if (tree[p] === undefined) created.push(p)
      tree[p] = content
    },
    watch: () => ({ close: () => {} }),
    scheduleTimeout: (fn) => {
      void fn
      return () => {}
    }
  }
  const files = new FileContentManager(() => {}, fileIO)

  const watched: string[] = []
  const listeners: Array<() => void> = []
  const metaDeps: AgentMetaDeps = {
    scanIO,
    watchDir: (path, onChange): DirWatchHandle | null => {
      watched.push(path)
      listeners.push(onChange)
      return { close: () => {} }
    },
    // Fire the debounce immediately: the debounce itself is not what these
    // tests are about, and a fake timer here would only slow them down.
    scheduleTimeout: (fn) => {
      fn()
      return () => {}
    },
    now: () => 1_000_000
  }

  const manager = new AgentMetaManager(sm, files, metaDeps)
  return {
    sm,
    manager,
    tree,
    created,
    watched,
    fireWatch: () => listeners.forEach((fn) => fn()),
    doc: () => JSON.parse(serializeState(sm.getState()))
  }
}

const skillFile = (desc: string) => `---\ndescription: ${desc}\n---\nbody`

/** A project with two skills and a CLAUDE.md. */
const PROJECT = {
  '/w/proj': null,
  '/w/proj/CLAUDE.md': '# Project',
  '/w/proj/.claude': null,
  '/w/proj/.claude/skills': null,
  '/w/proj/.claude/skills/alpha': null,
  '/w/proj/.claude/skills/alpha/SKILL.md': skillFile('alpha'),
  '/w/proj/.claude/skills/beta': null,
  '/w/proj/.claude/skills/beta/SKILL.md': skillFile('beta')
} as Record<string, string | null>

function addDirectoryHost(sm: StateManager, cwd = '/w/proj'): NodeId {
  return sm.createDirectory(ROOT_NODE_ID, 0, 0, cwd).id
}

function generated(sm: StateManager): NodeData[] {
  return Object.values(sm.getState().nodes).filter((n) => n.ephemeral)
}

function docsOf(sm: StateManager): MetaDocNodeData[] {
  return generated(sm).filter((n): n is MetaDocNodeData => n.type === 'meta-doc')
}

function groupsOf(sm: StateManager): MetaGroupNodeData[] {
  return generated(sm).filter((n): n is MetaGroupNodeData => n.type === 'meta-group')
}

let h: Harness
beforeEach(() => {
  h = harness(PROJECT)
})

describe('opening a branch', () => {
  it('builds a group, a skills sub-group, and a card per document', () => {
    const host = addDirectoryHost(h.sm)
    expect(h.manager.enable(host)).toBe(true)

    expect(groupsOf(h.sm).map((g) => g.groupKind).sort()).toEqual(['meta', 'skills'])
    expect(docsOf(h.sm).map((d) => d.docKey).sort()).toEqual(['CLAUDE.md', 'alpha', 'beta'])
  })

  it('hangs skills off the Skills group and documents off the branch root', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)

    const meta = groupsOf(h.sm).find((g) => g.groupKind === 'meta')!
    const skills = groupsOf(h.sm).find((g) => g.groupKind === 'skills')!
    const byKey = new Map(docsOf(h.sm).map((d) => [d.docKey, d]))

    expect(skills.parentId).toBe(meta.id)
    expect(byKey.get('CLAUDE.md')!.parentId).toBe(meta.id)
    expect(byKey.get('alpha')!.parentId).toBe(skills.id)
  })

  it('refuses a host with nothing to show', () => {
    const bare = harness({ '/w/plain': null, '/w/plain/index.ts': 'x' })
    const host = addDirectoryHost(bare.sm, '/w/plain')
    expect(bare.manager.enable(host)).toBe(false)
    expect(generated(bare.sm)).toEqual([])
  })

  it('counts the skills in the group label', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    expect(groupsOf(h.sm).find((g) => g.groupKind === 'skills')!.label).toBe('Skills · 2')
  })

  it('expands ~ before scanning, because a directory cwd is stored abbreviated', () => {
    // `createDirectory` runs abbreviateCwd, so the common case under $HOME is
    // stored as `~/proj`. Handing that to the scanner unexpanded means the
    // feature never works for the majority of real directory nodes.
    const home = harness({
      [`${HOME}/proj`]: null,
      [`${HOME}/proj/CLAUDE.md`]: '# hi'
    })
    const host = home.sm.createDirectory(ROOT_NODE_ID, 0, 0, `${HOME}/proj`).id
    expect(home.sm.getNode(host)).toMatchObject({ cwd: expect.stringContaining('~') })
    expect(home.manager.enable(host)).toBe(true)
  })
})

describe('rescanning is a diff, not a rebuild', () => {
  it('leaves an unchanged card completely alone', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    const alpha = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    h.sm.batchMoveNodes([{ nodeId: alpha.id, x: 900, y: 800 }])

    // A third skill appears next to it.
    h.tree['/w/proj/.claude/skills/gamma'] = null
    h.tree['/w/proj/.claude/skills/gamma/SKILL.md'] = skillFile('gamma')
    h.fireWatch()

    expect(docsOf(h.sm).map((d) => d.docKey).sort()).toEqual(['CLAUDE.md', 'alpha', 'beta', 'gamma'])
    // Same node, same place — so its position and its expanded state survive.
    const after = h.sm.getNode(alpha.id)
    expect(after).toBeDefined()
    expect(after).toMatchObject({ x: 900, y: 800 })
  })

  it('drops the card for a skill that was deleted', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    delete h.tree['/w/proj/.claude/skills/beta']
    h.fireWatch()

    expect(docsOf(h.sm).map((d) => d.docKey).sort()).toEqual(['CLAUDE.md', 'alpha'])
  })

  it('never recreates a file it is only supposed to be reading', () => {
    // The grenade: FileContentManager creates a missing file and mkdirs its
    // parent. A skill deleted inside the debounce window would have its
    // directory and an empty SKILL.md written back into the user's repo.
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    h.fireWatch()

    expect(h.created).toEqual([])
    expect(h.tree['/w/proj/.claude/skills/beta/SKILL.md']).toBeUndefined()
  })

  it('removes the Skills group when the last skill goes, keeping the documents', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    delete h.tree['/w/proj/.claude/skills/alpha/SKILL.md']
    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    h.fireWatch()

    expect(groupsOf(h.sm).map((g) => g.groupKind)).toEqual(['meta'])
    expect(docsOf(h.sm).map((d) => d.docKey)).toEqual(['CLAUDE.md'])
  })

  it('closes the branch when everything it showed is gone', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    delete h.tree['/w/proj/CLAUDE.md']
    delete h.tree['/w/proj/.claude/skills/alpha/SKILL.md']
    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    h.fireWatch()

    expect(generated(h.sm)).toEqual([])
    expect(h.manager.isEnabled(host)).toBe(false)
  })

  it('ignores the watch event its own write caused', () => {
    // The write-back path edits files inside the tree being watched, so without
    // suppression every pause in typing would fire a rescan.
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    const alpha = docsOf(h.sm).find((d) => d.docKey === 'alpha')!

    h.manager.noteSelfWrite(alpha.id)
    // A skill appearing during the grace window is deliberately not picked up
    // until the next unrelated event; the alternative is a rescan per keystroke.
    h.tree['/w/proj/.claude/skills/gamma'] = null
    h.tree['/w/proj/.claude/skills/gamma/SKILL.md'] = skillFile('gamma')
    h.fireWatch()

    expect(docsOf(h.sm).map((d) => d.docKey)).not.toContain('gamma')
  })
})

describe('positions are remembered by what the card shows', () => {
  it('survives a close and reopen', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    const alpha = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    h.sm.batchMoveNodes([{ nodeId: alpha.id, x: 1234, y: 5678 }])

    h.manager.disable(host)
    h.manager.enable(host)

    const again = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    expect(again).toMatchObject({ x: 1234, y: 5678 })
  })

  it('forgets a card whose skill no longer exists', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    const beta = docsOf(h.sm).find((d) => d.docKey === 'beta')!
    h.sm.batchMoveNodes([{ nodeId: beta.id, x: 10, y: 20 }])
    expect(h.sm.getMetaHost(host)?.cardPos).toHaveProperty('beta')

    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    h.fireWatch()

    expect(h.sm.getMetaHost(host)?.cardPos ?? {}).not.toHaveProperty('beta')
  })

  it('does not carry one directory’s layout to another', () => {
    // `code-review` and `finish` each exist under more than one root on this
    // machine, so a same-named skill inheriting the previous repo's position
    // is a real misplacement, not a theoretical one.
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    const alpha = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    h.sm.batchMoveNodes([{ nodeId: alpha.id, x: 4444, y: 4444 }])

    h.tree['/w/other'] = null
    h.tree['/w/other/.claude'] = null
    h.tree['/w/other/.claude/skills'] = null
    h.tree['/w/other/.claude/skills/alpha'] = null
    h.tree['/w/other/.claude/skills/alpha/SKILL.md'] = skillFile('a different alpha')
    h.sm.updateDirectoryCwd(host, '/w/other')
    h.manager.onHostChanged(host)

    const moved = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    expect(moved.x).not.toBe(4444)
  })
})

describe('the branch leaves no trace in the document', () => {
  it('is byte-identical when nothing was rearranged', () => {
    // Open it, look at it, close it: the document must not be able to tell.
    const host = addDirectoryHost(h.sm)
    const before = serializeState(h.sm.getState())

    h.manager.enable(host)
    h.sm.bringToFront(docsOf(h.sm)[0].id)
    h.manager.disable(host)

    expect(serializeState(h.sm.getState())).toBe(before)
  })

  it('keeps a rearranged layout, and nothing else, across a close', () => {
    // The layout is the one thing worth surviving — closing and reopening a
    // panel is an ordinary thing to do repeatedly, and losing the arrangement
    // each time would make dragging the cards pointless.
    const host = addDirectoryHost(h.sm)
    const beforeNodes = h.doc().nodes

    h.manager.enable(host)
    const alpha = docsOf(h.sm).find((d) => d.docKey === 'alpha')!
    h.sm.batchMoveNodes([{ nodeId: alpha.id, x: 77, y: 88 }])
    h.manager.disable(host)

    const after = h.doc()
    expect(after.nodes).toEqual(beforeNodes)
    expect(after.metaHosts[host]).toEqual({ open: false, cardPos: { alpha: { x: 77, y: 88 } } })
  })

  it('writes only the fact that it is open, never the cards', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)

    const doc = h.doc()
    expect(Object.keys(doc.nodes)).toEqual([host])
    expect(doc.metaHosts).toHaveProperty(host)
  })

  it('reopens what was open, at startup', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    h.manager.dispose()
    // Simulate a fresh process against the same state: the nodes are gone from
    // memory, the metaHosts record is not.
    for (const id of h.sm.ephemeralNodeIds()) h.sm.removeEphemeralNode(id)
    expect(generated(h.sm)).toEqual([])

    h.manager.restoreFromState()
    expect(docsOf(h.sm).map((d) => d.docKey).sort()).toEqual(['CLAUDE.md', 'alpha', 'beta'])
  })

  it('forgets a host whose directory stopped having anything to show', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    h.manager.dispose()
    for (const id of h.sm.ephemeralNodeIds()) h.sm.removeEphemeralNode(id)

    delete h.tree['/w/proj/CLAUDE.md']
    delete h.tree['/w/proj/.claude/skills/alpha/SKILL.md']
    delete h.tree['/w/proj/.claude/skills/beta/SKILL.md']
    h.manager.restoreFromState()

    expect(h.sm.getMetaHosts()).toEqual({})
  })
})

describe('the host going away', () => {
  it('takes the branch with it', () => {
    const host = addDirectoryHost(h.sm)
    h.manager.enable(host)
    h.manager.onHostRemoved(host)
    expect(generated(h.sm)).toEqual([])
    expect(h.sm.getMetaHosts()).toEqual({})
  })
})
