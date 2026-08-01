import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './daemon-client'
import { SessionManager, type SessionManagerDeps } from './session-manager'
import { FakeDaemon } from './testing/fake-daemon'
import { asNodeId as nid, asPtySessionId as pid, asClaudeSessionId as cid } from '../shared/ids'

/**
 * Drives the session lifecycle end to end against an in-memory daemon: create,
 * PTY output through the TitleParser / DataBatcher / ScrollbackBuffer pipeline,
 * resize, write, exit. No Go binary, no socket.
 *
 * DataBatcher flushes on a 16ms timer, so anything asserting on onData waits for
 * it rather than assuming synchronous delivery.
 */
function recorder() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    onTitleHistory: vi.fn(),
    onCwd: vi.fn(),
    onClaudeSessionHistory: vi.fn(),
    onClaudeState: vi.fn(),
    onClaudeContext: vi.fn(),
    onClaudeSessionLineCount: vi.fn(),
    onClaudeStatusUnread: vi.fn(),
    onClaudeStatusAsleep: vi.fn(),
    onActivity: vi.fn(),
  } satisfies SessionManagerDeps
}

async function setup() {
  const daemon = new FakeDaemon()
  const client = new DaemonClient(() => {}, { transport: daemon, reconnectDelayMs: 1 })
  await client.connect()
  const deps = recorder()
  const manager = new SessionManager(client, deps)
  return { daemon, client, deps, manager }
}

/** Frames the manager asked the daemon to run, by type. */
function sent(daemon: FakeDaemon, type: string) {
  return daemon.current.messages().filter((m) => m.type === type)
}

describe('SessionManager create', () => {
  it('asks the daemon to spawn a PTY', async () => {
    const { daemon, manager, client } = await setup()
    const info = manager.create()
    const [create] = sent(daemon, 'create')
    expect(create.id).toBe(info.sessionId)
    expect(create.cols).toBe(info.cols)
    expect(create.rows).toBe(info.rows)
    client.dispose()
  })

  it('returns a distinct id per session', async () => {
    const { manager, client } = await setup()
    expect(manager.create().sessionId).not.toBe(manager.create().sessionId)
    client.dispose()
  })

  it('passes the surface id to the PTY environment', async () => {
    const { daemon, manager, client } = await setup()
    const info = manager.create()
    const env = sent(daemon, 'create')[0].env as Record<string, string>
    expect(env.SPACETERM_SURFACE_ID).toBe(info.sessionId)
    client.dispose()
  })

  it('defaults the stable node id to the session id', async () => {
    const { daemon, manager, client } = await setup()
    const info = manager.create()
    const env = sent(daemon, 'create')[0].env as Record<string, string>
    expect(env.SPACETERM_NODE_ID).toBe(info.sessionId)
    client.dispose()
  })

  it('keeps the node id distinct from the session id on reincarnation', async () => {
    // Reincarnation rebinds an existing node to a fresh PTY; SPACETERM_NODE_ID is
    // what lets the surface keep its identity across that.
    const { daemon, manager, client } = await setup()
    const info = manager.create({ nodeId: nid('stable-node') })
    const env = sent(daemon, 'create')[0].env as Record<string, string>
    expect(env.SPACETERM_NODE_ID).toBe('stable-node')
    expect(env.SPACETERM_SURFACE_ID).toBe(info.sessionId)
    client.dispose()
  })

  it('sets an explicit TERM, which the daemon does not inherit', async () => {
    const { daemon, manager, client } = await setup()
    manager.create()
    const env = sent(daemon, 'create')[0].env as Record<string, string>
    expect(env.TERM).toBe('xterm-256color')
    client.dispose()
  })

  it('spawns the requested command with its arguments', async () => {
    const { daemon, manager, client } = await setup()
    manager.create({ command: 'claude', args: ['--resume', 'abc'] })
    const [create] = sent(daemon, 'create')
    expect(create.command).toBe('claude')
    expect(create.args).toEqual(['--resume', 'abc'])
    client.dispose()
  })

  it('falls back to $HOME when the requested cwd does not exist', async () => {
    const { daemon, manager, client } = await setup()
    manager.create({ cwd: '/definitely/not/a/real/directory' })
    expect(sent(daemon, 'create')[0].cwd).toBe(process.env.HOME || '/')
    client.dispose()
  })

  it('uses the requested cwd when it exists', async () => {
    const { daemon, manager, client } = await setup()
    manager.create({ cwd: process.cwd() })
    expect(sent(daemon, 'create')[0].cwd).toBe(process.cwd())
    client.dispose()
  })
})

describe('SessionManager PTY output', () => {
  it('batches output through to onData', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, 'hello ')
    manager.handleDaemonData(sessionId, 'world')
    // One flush carrying both writes, not two.
    await vi.waitFor(() => expect(deps.onData).toHaveBeenCalledWith(sessionId, 'hello world'))
    expect(deps.onData).toHaveBeenCalledTimes(1)
    client.dispose()
  })

  it('accumulates scrollback', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, 'line one\n')
    await vi.waitFor(() => expect(deps.onData).toHaveBeenCalled())
    expect(manager.getScrollback(sessionId)).toBe('line one\n')
    client.dispose()
  })

  it('reports activity synchronously, before the batch flushes', async () => {
    // The footer's "last interacted" should not wait on a render frame.
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, 'x')
    expect(deps.onActivity).toHaveBeenCalledWith(sessionId)
    expect(deps.onData).not.toHaveBeenCalled()
    client.dispose()
  })

  it('extracts a window title from the stream', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, '\x1b]2;my-shell\x07')
    expect(deps.onTitleHistory).toHaveBeenCalledWith(sessionId, ['my-shell'])
    client.dispose()
  })

  it('keeps the newest title first and de-duplicates', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, '\x1b]2;first\x07')
    manager.handleDaemonData(sessionId, '\x1b]2;second\x07')
    manager.handleDaemonData(sessionId, '\x1b]2;first\x07')
    expect(deps.onTitleHistory).toHaveBeenLastCalledWith(sessionId, ['first', 'second'])
    client.dispose()
  })

  it('ignores titles known to be set spuriously', async () => {
    // "Claude Code" is re-set on every revival and would otherwise churn history.
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, '\x1b]2;Claude Code\x07')
    expect(deps.onTitleHistory).not.toHaveBeenCalled()
    client.dispose()
  })

  it('extracts a working directory from OSC 7', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, '\x1b]7;file://host/tmp/somewhere\x07')
    expect(deps.onCwd).toHaveBeenCalledWith(sessionId, '/tmp/somewhere')
    client.dispose()
  })

  it('parses a title split across two daemon chunks', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonData(sessionId, '\x1b]2;split')
    manager.handleDaemonData(sessionId, ' title\x07')
    expect(deps.onTitleHistory).toHaveBeenCalledWith(sessionId, ['split title'])
    client.dispose()
  })

  it('ignores output for an unknown session', async () => {
    const { manager, deps, client } = await setup()
    manager.handleDaemonData(pid('never-created'), 'data')
    expect(deps.onActivity).not.toHaveBeenCalled()
    client.dispose()
  })
})

describe('SessionManager lifecycle', () => {
  it('forwards writes to the daemon', async () => {
    const { daemon, manager, client } = await setup()
    const { sessionId } = manager.create()
    manager.write(sessionId, 'ls\n')
    expect(sent(daemon, 'write')[0]).toMatchObject({ id: sessionId, data: 'ls\n' })
    client.dispose()
  })

  it('drops writes to an unknown session', async () => {
    const { daemon, manager, client } = await setup()
    manager.write(pid('never-created'), 'ls\n')
    expect(sent(daemon, 'write')).toHaveLength(0)
    client.dispose()
  })

  it('forwards resizes to the daemon', async () => {
    const { daemon, manager, client } = await setup()
    const { sessionId } = manager.create()
    manager.resize(sessionId, 100, 40)
    expect(sent(daemon, 'resize')[0]).toMatchObject({ id: sessionId, cols: 100, rows: 40 })
    client.dispose()
  })

  it('reports the exit and forgets the session', async () => {
    const { manager, deps, client } = await setup()
    const { sessionId } = manager.create()
    manager.handleDaemonExit(sessionId, 3)
    expect(deps.onExit).toHaveBeenCalledWith(sessionId, 3)
    // Output arriving after the exit must not resurrect it.
    manager.handleDaemonData(sessionId, 'late')
    expect(deps.onActivity).not.toHaveBeenCalled()
    client.dispose()
  })

  it('destroys the PTY in the daemon', async () => {
    const { daemon, manager, client } = await setup()
    const { sessionId } = manager.create()
    manager.destroy(sessionId)
    expect(sent(daemon, 'destroy')[0]).toMatchObject({ id: sessionId })
    client.dispose()
  })

  it('leaves daemon PTYs alone when only clearing local state', async () => {
    // destroyAll runs on server shutdown; the whole point is that sessions
    // survive in the daemon so a restart can re-attach to them.
    const { daemon, manager, client } = await setup()
    manager.create()
    manager.create()
    manager.destroyAll()
    expect(sent(daemon, 'destroy')).toHaveLength(0)
    client.dispose()
  })

  it('rebuilds local state when re-attaching after a server restart', async () => {
    const { manager, deps, client } = await setup()
    manager.reattachSession(pid('restored'), '\x1b]2;recovered\x07some output', 120, 30)
    // Title and scrollback are rebuilt from the replay...
    expect(deps.onTitleHistory).toHaveBeenCalledWith('restored', ['recovered'])
    expect(manager.getScrollback(pid('restored'))).toContain('some output')
    // ...but the replay must not be broadcast as if it were live output.
    expect(deps.onData).not.toHaveBeenCalled()
    client.dispose()
  })
})
