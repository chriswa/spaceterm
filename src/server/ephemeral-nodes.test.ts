import { describe, it, expect } from 'vitest'
import { StateManager, type StateManagerDeps } from './state-manager'
import { StatePersister, serializeState } from './persistence'
import { FakePersistenceIO } from './testing/fake-persistence'
import type { NodeData, ServerState, TitleNodeData } from '../shared/state'
import { asNodeId as nid, ROOT_NODE_ID, type NodeId } from '../shared/ids'

/**
 * The rule generated cards live by, tested against the *generic* paths rather
 * than the ones a feature author would remember.
 *
 * Every leak that review found in the design of this feature had the same
 * shape: not a call site anyone chose to guard, but a shared path over
 * `state.nodes` — dragging a subtree, archiving a subtree, bringing a card to
 * the front — that treats every node the same. So these tests drive those paths
 * and assert about the *document*, not about the method.
 *
 * A `title` node stands in for the real generated card types. That is
 * deliberate: `ephemeral` is a field on `BaseNodeData`, not a property of a
 * card type, so the guarantee is testable — and was built — before either new
 * card type existed.
 */

const DEBOUNCE = 1000

function harness() {
  const io = new FakePersistenceIO()
  const removes: NodeId[] = []
  const deps: StateManagerDeps = {
    onNodeUpdate: () => {},
    onNodeAdd: () => {},
    onNodeRemove: (nodeId) => removes.push(nodeId)
  }
  const sm = new StateManager(deps, { persister: new StatePersister(io, DEBOUNCE) })
  return { sm, io, removes }
}

/** A generated card hanging off `parentId`. */
function addGenerated(sm: StateManager, id: string, parentId: NodeId): NodeData {
  const node: TitleNodeData = {
    id: nid(id),
    type: 'title',
    parentId,
    x: 10,
    y: 20,
    zIndex: 0,
    text: 'Agent Meta',
    archivedChildren: []
  }
  return sm.addEphemeralNode(node)
}

/** What the debounced writer would put on disk right now. */
function persisted(sm: StateManager): ServerState {
  return JSON.parse(serializeState(sm.getState()))
}

describe('generated cards never reach the document', () => {
  it('are dropped from the node map on write', () => {
    const { sm } = harness()
    const real = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    addGenerated(sm, 'meta:1', real.id)

    const doc = persisted(sm)
    expect(Object.keys(doc.nodes)).toEqual([real.id])
  })

  it('leave no null hole behind — the archivedChildren array trap', () => {
    // Dropping a node by returning undefined from a JSON.stringify replacer
    // works inside an object and writes `null` inside an ARRAY. A hole in
    // archivedChildren is read back as an entry and dereferenced for
    // `.data.id` on the next load, so the filter rebuilds the node map by key
    // instead. Assert on the raw text: `toEqual` would not see a null.
    const { sm } = harness()
    const real = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    addGenerated(sm, 'meta:1', real.id)
    expect(serializeState(sm.getState())).not.toContain('null')
  })

  it('survive a round trip as an absence, not as a corrupt entry', () => {
    const { sm, io } = harness()
    sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    io.write(serializeState(sm.getState()))

    const reloaded = new StatePersister(io, DEBOUNCE).load()
    expect(reloaded.outcome.status).toBe('ok')
    expect(Object.values(reloaded.state.nodes).some((n) => n.ephemeral)).toBe(false)
  })
})

describe('the generic paths that would otherwise treat them as real', () => {
  it('does not advance the persisted z-counter when one is brought to front', () => {
    // `nextZIndex` IS persisted, so raising a generated card would move a
    // number on disk every time one was clicked.
    const { sm } = harness()
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    const before = sm.getState().nextZIndex

    sm.bringToFront(generated.id)

    expect(sm.getState().nextZIndex).toBe(before)
  })

  it('does not persist a subtree drag that only moved generated cards', () => {
    // Dragging a card drags its whole subtree, so this is the path a generated
    // card takes on the most ordinary gesture in the feature.
    const { sm } = harness()
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    const before = sm.getState().nextZIndex

    sm.batchMoveNodes([{ nodeId: generated.id, x: 500, y: 600 }])

    expect(persisted(sm).nodes[generated.id]).toBeUndefined()
    expect(sm.getState().nextZIndex).toBe(before)
    // The move still took effect in memory — the card follows the mouse.
    expect(sm.getNode(generated.id)?.x).toBe(500)
  })

  it('records nothing about them when their host subtree is archived', () => {
    // archiveSubtree deep-copies the whole live subtree into persisted
    // `descendants`. This is the vector that would put generated ids in
    // state.json AND resurrect stale copies of files as real nodes on restore.
    const { sm } = harness()
    const host = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    const generated = addGenerated(sm, 'meta:1', host.id)

    const removed = sm.archiveSubtree(host.id)

    // Removed from the canvas with the subtree...
    expect(removed).toContain(generated.id)
    expect(sm.getNode(generated.id)).toBeUndefined()
    // ...but nowhere in what gets written down.
    expect(serializeState(sm.getState())).not.toContain('meta:1')
  })

  it('refuses to archive one on its own', () => {
    const { sm } = harness()
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    sm.archiveNode(generated.id)
    expect(sm.getNode(generated.id)).toBeDefined()
    expect(persisted(sm).rootArchivedChildren).toEqual([])
  })

  it('refuses to reparent one, in either direction', () => {
    const { sm } = harness()
    const real = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)

    sm.reparentNode(generated.id, real.id)
    expect(sm.getNode(generated.id)?.parentId).toBe(ROOT_NODE_ID)

    // The direction that actually corrupts: a real node whose parentId is a
    // generated card is written to disk pointing at something that will not
    // exist next boot.
    sm.reparentNode(real.id, generated.id)
    expect(sm.getNode(real.id)?.parentId).toBe(ROOT_NODE_ID)
  })

  it('refuses a rename or a colour rather than silently losing it', () => {
    const { sm } = harness()
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    sm.renameNode(generated.id, 'mine')
    sm.setNodeColor(generated.id, 'red')
    expect(sm.getNode(generated.id)?.name).toBeUndefined()
    expect(sm.getNode(generated.id)?.colorPresetId).toBeUndefined()
  })

  it('drops them rather than re-homing them when their host is archived alone', () => {
    const { sm } = harness()
    const host = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    const generated = addGenerated(sm, 'meta:1', host.id)

    sm.archiveNode(host.id)

    // A card describing a directory that is no longer above it would be a lie.
    expect(sm.getNode(generated.id)?.parentId).not.toBe(ROOT_NODE_ID)
  })
})

describe('turning the branch on and off changes nothing that persists', () => {
  it('leaves the written document byte-identical', () => {
    // The headline invariant: enabling a branch, moving its cards around,
    // and disabling it must be indistinguishable on disk from never having
    // touched it.
    const { sm } = harness()
    sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    sm.createTitle(ROOT_NODE_ID, 5, 5, 'a real title')
    const before = serializeState(sm.getState())

    const group = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    const card = addGenerated(sm, 'meta:1:skill:a', group.id)
    sm.batchMoveNodes([
      { nodeId: group.id, x: 111, y: 222 },
      { nodeId: card.id, x: 333, y: 444 }
    ])
    sm.bringToFront(card.id)
    sm.removeEphemeralNode(card.id)
    sm.removeEphemeralNode(group.id)

    expect(serializeState(sm.getState())).toBe(before)
  })
})

describe('the orphan tripwire', () => {
  it('throws under test if a real node would persist under a generated parent', () => {
    // Unreachable through the API — reparenting onto a generated card is
    // refused above. Reached here by forcing the field, because a tripwire
    // that is never exercised is a tripwire nobody knows is broken.
    const { sm } = harness()
    const generated = addGenerated(sm, 'meta:1', ROOT_NODE_ID)
    const real = sm.createDirectory(ROOT_NODE_ID, 0, 0, '/w/proj')
    ;(sm.getState().nodes[real.id] as NodeData).parentId = generated.id

    expect(() => serializeState(sm.getState())).toThrow(/generated parent/)
  })
})
