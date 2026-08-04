import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { FakeBridge, installFakeBridge } from '../testing/fake-bridge'
import {
  initServerSync, destroyServerSync,
  sendMove, sendRename, sendArchive, sendTerminalCreate, sendMarkdownContent
} from './server-sync'
import { useNodeStore } from '../stores/nodeStore'
import { usePeerStore } from '../stores/peerStore'
import { useSpeakingStore } from '../stores/speakingStore'
import { useSavedViewportStore } from '../stores/savedViewportStore'
import { useNotificationSoundStore } from '../stores/notificationSoundStore'
import { resetAudioAvailabilityForTest } from './sounds'
import type { NodeData, ServerState } from '../../../../shared/state'
import { asNodeId, asPtySessionId, ROOT_NODE_ID, type NodeId } from '../../../../shared/ids'

/**
 * `server-sync.ts` driven against a fake preload bridge, with real zustand
 * stores underneath.
 *
 * This is the first test of anything under `src/client/renderer/`, and it is
 * possible only because the renderer's sole Electron dependency is
 * `window.api`. There is no Electron binary in this container and there cannot
 * be — `npm install --ignore-scripts` skips the postinstall that downloads it —
 * so the choice was always between faking that one object and testing nothing.
 *
 * Everything below the bridge is production code: real stores, real
 * subscription wiring, real state application.
 */

const nid = asNodeId
const pid = asPtySessionId

function terminal(id: string, overrides: Partial<Record<string, unknown>> = {}): NodeData {
  return {
    type: 'terminal', id: nid(id), parentId: ROOT_NODE_ID,
    x: 0, y: 0, zIndex: 1, sessionId: pid(id), cols: 80, rows: 24, alive: true,
    claudeState: 'stopped', claudeStatusUnread: false, claudeStatusAsleep: false,
    sortOrder: 0, terminalSessions: [], claudeSessionHistory: [],
    shellTitleHistory: [], archivedChildren: [], ...overrides
  } as unknown as NodeData
}

function serverState(...nodes: NodeData[]): ServerState {
  return {
    version: 2, nextZIndex: 10,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    rootArchivedChildren: [], undoBuffer: [], undoCursor: -1,
    savedViewports: {}
  }
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  resetAudioAvailabilityForTest()
  useNodeStore.setState({ nodes: {} })
  usePeerStore.setState({ peers: {} } as never)
})

afterEach(() => {
  destroyServerSync()
})

describe('initServerSync', () => {
  it('pulls full state from the server and applies it', async () => {
    bridge.responses.syncRequest = serverState(terminal('t1'), terminal('t2'))
    await initServerSync()

    expect(Object.keys(useNodeStore.getState().nodes).sort()).toEqual(['t1', 't2'])
  })

  it('hydrates saved viewports from the pull, not only from the push', async () => {
    // The onSavedViewports PUSH fires on a fresh main-process socket connect,
    // which does not repeat across a renderer refresh while the socket stays
    // open — so the pull is the only source of truth on reload.
    bridge.responses.syncRequest = {
      ...serverState(),
      savedViewports: { '3': { x: 1, y: 2, width: 100, height: 80 } }
    }
    await initServerSync()

    expect(useSavedViewportStore.getState().viewports['3']).toEqual({ x: 1, y: 2, width: 100, height: 80 })
  })

  it('survives a server that is not connected yet', async () => {
    // The renderer loads before the socket is up on a cold boot; a rejected
    // sync must leave the app usable rather than unmounting the tree.
    bridge.failing.add('node.syncRequest')
    await expect(initServerSync()).resolves.toBeUndefined()
    expect(useNodeStore.getState().nodes).toEqual({})
  })

  it('still wires its subscriptions when the initial sync fails', async () => {
    // Otherwise a cold boot would leave the renderer permanently deaf to
    // server events, with no error and no retry.
    bridge.failing.add('node.syncRequest')
    await initServerSync()

    bridge.emit.nodeAdded(terminal('late'))
    expect(useNodeStore.getState().nodes.late).toBeDefined()
  })
})

describe('server events reach the stores', () => {
  beforeEach(async () => { await initServerSync() })

  it('applies a node arriving', () => {
    bridge.emit.nodeAdded(terminal('t1', { name: 'work' }))
    expect(useNodeStore.getState().nodes.t1).toMatchObject({ name: 'work' })
  })

  it('applies a node patch', () => {
    bridge.emit.nodeAdded(terminal('t1'))
    bridge.emit.nodeUpdated(nid('t1'), { name: 'renamed' })
    expect(useNodeStore.getState().nodes.t1).toMatchObject({ name: 'renamed' })
  })

  it('applies a node removal', () => {
    bridge.emit.nodeAdded(terminal('t1'))
    bridge.emit.nodeRemoved(nid('t1'))
    expect(useNodeStore.getState().nodes.t1).toBeUndefined()
  })

  it('tracks peers connecting and disconnecting', () => {
    bridge.emit.peerConnected('peer-1')
    expect(Object.keys(usePeerStore.getState().peers)).toContain('peer-1')

    bridge.emit.peerDisconnected('peer-1')
    expect(Object.keys(usePeerStore.getState().peers)).not.toContain('peer-1')
  })

  it('tracks which surface is speaking', () => {
    bridge.emit.nodeAdded(terminal('t1'))
    bridge.emit.speakingChanged(nid('t1'), true, 'Zoe')
    expect(useSpeakingStore.getState().speaking).toHaveProperty('t1')

    bridge.emit.speakingChanged(nid('t1'), false, undefined)
    expect(useSpeakingStore.getState().speaking.t1).toBeFalsy()
  })

  it('logs a speaking event for a node it does not know about', () => {
    // A stale nodeId reaching the speaking indicator is worth a log line: it
    // means the server and renderer disagree about what exists.
    bridge.emit.speakingChanged(nid('ghost'), true, 'Zoe')
    expect(bridge.callsTo('log').length).toBeGreaterThan(0)
  })

  it('replaces saved viewports wholesale on a push', () => {
    bridge.emit.savedViewports({ '7': { x: 0, y: 0, width: 10, height: 10 } })
    expect(useSavedViewportStore.getState().viewports['7']).toBeDefined()
  })
})

describe('the notification sound', () => {
  beforeEach(async () => { await initServerSync() })

  it('does not stop a node update from being applied when audio fails', () => {
    // The sound plays INSIDE the node-updated handler, before the patch is
    // applied. An AudioContext that cannot be constructed used to take the
    // update down with it, and a surface going unread would silently stop
    // updating on screen.
    useNotificationSoundStore.setState({ enabled: true } as never)
    const original = globalThis.AudioContext
    Object.defineProperty(globalThis, 'AudioContext', {
      writable: true, configurable: true,
      value: class { constructor() { throw new Error('autoplay blocked') } }
    })
    resetAudioAvailabilityForTest()

    try {
      bridge.emit.nodeAdded(terminal('t1'))
      bridge.emit.nodeUpdated(nid('t1'), { claudeStatusUnread: true } as Partial<NodeData>)
      expect(useNodeStore.getState().nodes.t1).toMatchObject({ claudeStatusUnread: true })
    } finally {
      Object.defineProperty(globalThis, 'AudioContext', { writable: true, configurable: true, value: original })
      resetAudioAvailabilityForTest()
    }
  })

  it('does not stop a node ARRIVING already unread either', () => {
    useNotificationSoundStore.setState({ enabled: true } as never)
    const original = globalThis.AudioContext
    Object.defineProperty(globalThis, 'AudioContext', {
      writable: true, configurable: true,
      value: class { constructor() { throw new Error('no audio device') } }
    })
    resetAudioAvailabilityForTest()

    try {
      bridge.emit.nodeAdded(terminal('t1', { claudeStatusUnread: true }))
      expect(useNodeStore.getState().nodes.t1).toBeDefined()
    } finally {
      Object.defineProperty(globalThis, 'AudioContext', { writable: true, configurable: true, value: original })
      resetAudioAvailabilityForTest()
    }
  })

  it('stays silent when the user turned it off', () => {
    useNotificationSoundStore.setState({ enabled: false } as never)
    bridge.emit.nodeAdded(terminal('t1', { claudeStatusUnread: true }))
    expect(useNodeStore.getState().nodes.t1).toBeDefined()
  })
})

describe('mutations reach the server', () => {
  beforeEach(async () => {
    await initServerSync()
    bridge.resetCalls()
  })

  it('sends a move with the node and coordinates', async () => {
    await sendMove(nid('t1'), 12, 34)
    expect(bridge.lastCall('node.move')).toEqual([nid('t1'), 12, 34])
  })

  it('sends a rename', async () => {
    await sendRename(nid('t1'), 'new name')
    expect(bridge.lastCall('node.rename')).toEqual([nid('t1'), 'new name'])
  })

  it('sends an archive', async () => {
    await sendArchive(nid('t1'))
    expect(bridge.lastCall('node.archive')).toEqual([nid('t1')])
  })

  it('sends markdown content', async () => {
    await sendMarkdownContent(nid('md'), '# hello')
    expect(bridge.lastCall('node.markdownContent')).toEqual([nid('md'), '# hello'])
  })

  it('passes terminal-create arguments through in the declared order', async () => {
    // directoryAdd's parameters were once declared in the opposite order from
    // the implementation, which is exactly the kind of drift a recorded call
    // catches and a type alone does not.
    await sendTerminalCreate(nid('parent'), { cwd: '/work' }, ['vim'], 'named', 10, 20, 'echo hi')
    expect(bridge.lastCall('node.terminalCreate')).toEqual([
      nid('parent'), { cwd: '/work' }, ['vim'], 'named', 10, 20, 'echo hi'
    ])
  })
})

describe('destroyServerSync', () => {
  it('unsubscribes everything', async () => {
    await initServerSync()
    expect(bridge.listenerCount('added')).toBeGreaterThan(0)

    destroyServerSync()
    expect(bridge.listenerCount('added')).toBe(0)
    expect(bridge.listenerCount('updated')).toBe(0)
    expect(bridge.listenerCount('removed')).toBe(0)
  })

  it('leaves the stores alone — teardown is not a reset', async () => {
    bridge.responses.syncRequest = serverState(terminal('t1'))
    await initServerSync()
    destroyServerSync()

    expect(useNodeStore.getState().nodes.t1).toBeDefined()
  })

  it('is safe to call twice', async () => {
    await initServerSync()
    destroyServerSync()
    expect(() => destroyServerSync()).not.toThrow()
  })

  it('stops delivering events after teardown', async () => {
    await initServerSync()
    destroyServerSync()

    bridge.emit.nodeAdded(terminal('late'))
    expect(useNodeStore.getState().nodes.late).toBeUndefined()
  })

  it('does not leak listeners across an init/destroy cycle', async () => {
    // Two inits without a destroy between them would double every handler, so
    // a single node-added would be applied twice.
    for (let i = 0; i < 3; i++) {
      await initServerSync()
      destroyServerSync()
    }
    await initServerSync()
    expect(bridge.listenerCount('added')).toBe(1)
  })
})

describe('the fake bridge itself', () => {
  it('keeps per-session channels separate', () => {
    // pty output is per-session; a flat emitter would show one terminal's
    // output in all of them.
    const seen: string[] = []
    bridge.pty.onData(pid('a'), (d) => seen.push(`a:${d}`))
    bridge.pty.onData(pid('b'), (d) => seen.push(`b:${d}`))

    bridge.emit.ptyData(pid('a'), 'hello')
    expect(seen).toEqual(['a:hello'])
  })

  it('returns a working unsubscribe from every channel kind', () => {
    const global: NodeId[] = []
    const perSession: string[] = []
    const offGlobal = bridge.node.onRemoved((id) => global.push(id))
    const offSession = bridge.pty.onData(pid('a'), (d) => perSession.push(d))

    offGlobal()
    offSession()
    bridge.emit.nodeRemoved(nid('x'))
    bridge.emit.ptyData(pid('a'), 'x')

    expect(global).toEqual([])
    expect(perSession).toEqual([])
  })

  it('emitting to a session nobody subscribed to is a no-op, as the real bridge is', () => {
    expect(() => bridge.emit.ptyData(pid('nobody'), 'data')).not.toThrow()
  })
})
