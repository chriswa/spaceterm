import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR, SOCKET_PATH, HOOK_LOG_DIR } from '../shared/protocol'
import type { ClientMessage, ServerMessage } from '../shared/protocol'
import { SessionManager } from './session-manager'
import { StateManager } from './state-manager'
import { SnapshotManager } from './snapshot-manager'
import { setupShellIntegration } from './shell-integration'
import { LineParser } from './line-parser'

interface ClientConnection {
  socket: net.Socket
  attachedSessions: Set<string>
  /** Sessions where this client wants snapshot mode instead of live data */
  snapshotSessions: Set<string>
  parser: LineParser
}

const clients = new Set<ClientConnection>()
let sessionManager: SessionManager
let stateManager: StateManager
let snapshotManager: SnapshotManager

function localISOTimestamp(): string {
  const now = new Date()
  const offset = -now.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return (
    now.getFullYear() +
    '-' + String(now.getMonth() + 1).padStart(2, '0') +
    '-' + String(now.getDate()).padStart(2, '0') +
    'T' + String(now.getHours()).padStart(2, '0') +
    ':' + String(now.getMinutes()).padStart(2, '0') +
    ':' + String(now.getSeconds()).padStart(2, '0') +
    '.' + String(now.getMilliseconds()).padStart(3, '0') +
    sign + hh + ':' + mm
  )
}

function send(socket: net.Socket, msg: ServerMessage): void {
  try {
    socket.write(JSON.stringify(msg) + '\n')
  } catch {
    // Client disconnected
  }
}

function broadcastToAttached(sessionId: string, msg: ServerMessage): void {
  clients.forEach((client) => {
    if (client.attachedSessions.has(sessionId)) {
      send(client.socket, msg)
    }
  })
}

function broadcastToAll(msg: ServerMessage): void {
  clients.forEach((client) => {
    send(client.socket, msg)
  })
}

function handleMessage(client: ClientConnection, msg: ClientMessage): void {
  switch (msg.type) {
    case 'create': {
      const { sessionId, cols, rows } = sessionManager.create(msg.options)
      send(client.socket, { type: 'created', seq: msg.seq, sessionId, cols, rows })
      break
    }

    case 'list': {
      const sessions = sessionManager.list()
      send(client.socket, { type: 'listed', seq: msg.seq, sessions })
      break
    }

    case 'attach': {
      const scrollback = sessionManager.getScrollback(msg.sessionId)
      if (scrollback !== null) {
        client.attachedSessions.add(msg.sessionId)
        send(client.socket, {
          type: 'attached',
          seq: msg.seq,
          sessionId: msg.sessionId,
          scrollback,
          shellTitleHistory: sessionManager.getShellTitleHistory(msg.sessionId),
          cwd: sessionManager.getCwd(msg.sessionId),
          claudeSessionHistory: sessionManager.getClaudeSessionHistory(msg.sessionId),
          claudeState: sessionManager.getClaudeState(msg.sessionId)
        })
      } else {
        // Session doesn't exist — send attached with empty scrollback
        // so client can handle gracefully
        send(client.socket, {
          type: 'attached',
          seq: msg.seq,
          sessionId: msg.sessionId,
          scrollback: ''
        })
      }
      break
    }

    case 'detach': {
      client.attachedSessions.delete(msg.sessionId)
      send(client.socket, { type: 'detached', seq: msg.seq, sessionId: msg.sessionId })
      break
    }

    case 'destroy': {
      sessionManager.destroy(msg.sessionId)
      // Remove from all clients' attached sets
      clients.forEach((c) => {
        c.attachedSessions.delete(msg.sessionId)
      })
      send(client.socket, { type: 'destroyed', seq: msg.seq })
      break
    }

    case 'write': {
      sessionManager.write(msg.sessionId, msg.data)
      break
    }

    case 'resize': {
      sessionManager.resize(msg.sessionId, msg.cols, msg.rows)
      break
    }

    case 'hook': {
      const hookType =
        msg.payload && typeof msg.payload === 'object' && 'hook_event_name' in msg.payload
          ? String(msg.payload.hook_event_name)
          : 'unknown'
      const logEntry =
        JSON.stringify({
          timestamp: localISOTimestamp(),
          hookType,
          payload: msg.payload
        }) + '\n'
      const logPath = path.join(HOOK_LOG_DIR, `${msg.surfaceId}.jsonl`)
      fs.appendFile(logPath, logEntry, (err) => {
        if (err) console.error(`Failed to write hook log: ${err.message}`)
      })

      // Track Stop hooks so we can distinguish real forks from claude -r startups
      if (hookType === 'Stop') {
        sessionManager.handleClaudeStop(msg.surfaceId)
        sessionManager.setClaudeState(msg.surfaceId, 'stopped')
      }

      // PermissionRequest: check tool_name to distinguish plan approval from other permissions
      if (hookType === 'PermissionRequest') {
        const toolName = msg.payload && typeof msg.payload === 'object' && 'tool_name' in msg.payload
          ? String(msg.payload.tool_name)
          : ''
        sessionManager.setClaudeState(msg.surfaceId, toolName === 'ExitPlanMode' ? 'waiting_plan' : 'waiting_permission')
      }

      // Notification hooks: permission_prompt and elicitation_dialog mean user needs to act
      // But don't overwrite waiting_plan — the PermissionRequest hook already set it correctly
      if (hookType === 'Notification' && msg.payload && typeof msg.payload === 'object') {
        const notificationType = 'notification_type' in msg.payload ? String(msg.payload.notification_type) : ''
        if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
          const currentState = sessionManager.getClaudeState(msg.surfaceId)
          if (currentState !== 'waiting_plan') {
            sessionManager.setClaudeState(msg.surfaceId, 'waiting_permission')
          }
        }
      }

      // Claude is actively working
      if (hookType === 'UserPromptSubmit' || hookType === 'PreToolUse' || hookType === 'SubagentStart') {
        sessionManager.setClaudeState(msg.surfaceId, 'working')
      }

      // SessionEnd: session is done
      if (hookType === 'SessionEnd') {
        sessionManager.setClaudeState(msg.surfaceId, 'stopped')
      }

      // Process SessionStart hooks for claude session history tracking
      if (hookType === 'SessionStart' && msg.payload && typeof msg.payload === 'object') {
        const claudeSessionId = 'session_id' in msg.payload ? String(msg.payload.session_id) : ''
        const source = 'source' in msg.payload ? String(msg.payload.source) : 'startup'
        if (claudeSessionId) {
          sessionManager.handleClaudeSessionStart(msg.surfaceId, claudeSessionId, source)
        }
      }
      break
    }

    // --- Node state mutation messages ---

    case 'node-sync-request': {
      send(client.socket, { type: 'sync-state', seq: msg.seq, state: stateManager.getState() })
      break
    }

    case 'node-move': {
      stateManager.moveNode(msg.nodeId, msg.x, msg.y)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-batch-move': {
      stateManager.batchMoveNodes(msg.moves)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-rename': {
      stateManager.renameNode(msg.nodeId, msg.name)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-set-color': {
      stateManager.setNodeColor(msg.nodeId, msg.colorPresetId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-archive': {
      const node = stateManager.getNode(msg.nodeId)
      if (node && node.type === 'terminal' && node.alive) {
        snapshotManager.removeSession(node.sessionId)
        sessionManager.destroy(node.sessionId)
        clients.forEach((c) => {
          c.attachedSessions.delete(node.sessionId)
          c.snapshotSessions.delete(node.sessionId)
        })
      }
      stateManager.archiveNode(msg.nodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-unarchive': {
      stateManager.unarchiveNode(msg.parentNodeId, msg.archivedNodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-archive-delete': {
      stateManager.deleteArchivedNode(msg.parentNodeId, msg.archivedNodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-bring-to-front': {
      stateManager.bringToFront(msg.nodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-reparent': {
      stateManager.reparentNode(msg.nodeId, msg.newParentId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'terminal-create': {
      const { sessionId, cols, rows } = sessionManager.create(msg.options)
      snapshotManager.addSession(sessionId, cols, rows)
      const cwd = sessionManager.getCwd(sessionId)
      stateManager.createTerminal(sessionId, msg.parentId, msg.x, msg.y, cols, rows, cwd, msg.initialTitleHistory)
      if (msg.initialTitleHistory?.length) {
        sessionManager.seedTitleHistory(sessionId, msg.initialTitleHistory)
      }
      send(client.socket, { type: 'created', seq: msg.seq, sessionId, cols, rows })
      break
    }

    case 'terminal-resize': {
      const tNode = stateManager.getNode(msg.nodeId)
      const ptyId = tNode && tNode.type === 'terminal' ? tNode.sessionId : msg.nodeId
      sessionManager.resize(ptyId, msg.cols, msg.rows)
      snapshotManager.resize(ptyId, msg.cols, msg.rows)
      stateManager.updateTerminalSize(ptyId, msg.cols, msg.rows)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'terminal-reincarnate': {
      const rNode = stateManager.getNode(msg.nodeId)
      if (!rNode || rNode.type !== 'terminal' || rNode.alive) {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        break
      }
      const { sessionId: newPtyId, cols: rCols, rows: rRows } = sessionManager.create(msg.options)
      snapshotManager.addSession(newPtyId, rCols, rRows)
      // Seed the new PTY session with the remnant's title history before reincarnation
      if (rNode.shellTitleHistory?.length) {
        sessionManager.seedTitleHistory(newPtyId, rNode.shellTitleHistory)
      }
      stateManager.reincarnateTerminal(msg.nodeId, newPtyId, rCols, rRows)
      // Auto-attach client to the new PTY session
      client.attachedSessions.add(newPtyId)
      send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols: rCols, rows: rRows })
      break
    }

    case 'markdown-add': {
      stateManager.createMarkdown(msg.parentId, msg.x, msg.y)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'markdown-resize': {
      stateManager.resizeMarkdown(msg.nodeId, msg.width, msg.height)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'markdown-content': {
      stateManager.updateMarkdownContent(msg.nodeId, msg.content)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'set-terminal-mode': {
      if (msg.mode === 'snapshot') {
        client.snapshotSessions.add(msg.sessionId)
        // Send an immediate snapshot so the client has something to render
        const snap = snapshotManager.snapshotNow(msg.sessionId)
        if (snap) send(client.socket, snap)
      } else {
        client.snapshotSessions.delete(msg.sessionId)
      }
      break
    }
  }
}

function startServer(): void {
  // Write shell integration scripts (OSC 7 hooks for CWD reporting)
  setupShellIntegration()

  // Ensure socket directory exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true })
  fs.mkdirSync(HOOK_LOG_DIR, { recursive: true })

  // Remove stale socket file
  try {
    fs.unlinkSync(SOCKET_PATH)
  } catch {
    // File doesn't exist, that's fine
  }

  // Initialize StateManager — broadcasts node changes to all clients
  stateManager = new StateManager(
    (nodeId, fields) => {
      broadcastToAll({ type: 'node-updated', nodeId, fields })
    },
    (node) => {
      broadcastToAll({ type: 'node-added', node })
    },
    (nodeId) => {
      broadcastToAll({ type: 'node-removed', nodeId })
    }
  )

  // Initialize SnapshotManager — sends periodic snapshots to clients in snapshot mode
  snapshotManager = new SnapshotManager((snapshot) => {
    clients.forEach((client) => {
      if (client.snapshotSessions.has(snapshot.sessionId)) {
        send(client.socket, snapshot)
      }
    })
  })

  sessionManager = new SessionManager(
    // onData: broadcast to attached clients + feed snapshot manager
    (sessionId, data) => {
      snapshotManager.write(sessionId, data)
      broadcastToAttached(sessionId, { type: 'data', sessionId, data })
    },
    // onExit: broadcast to all attached clients + update state
    (sessionId, exitCode) => {
      snapshotManager.removeSession(sessionId)
      stateManager.terminalExited(sessionId, exitCode)
      broadcastToAttached(sessionId, { type: 'exit', sessionId, exitCode })
      // Remove from all clients' attached/snapshot sets
      clients.forEach((client) => {
        client.attachedSessions.delete(sessionId)
        client.snapshotSessions.delete(sessionId)
      })
    },
    // onTitleHistory: broadcast to all attached clients + update state
    (sessionId, history) => {
      stateManager.updateShellTitleHistory(sessionId, history)
      broadcastToAttached(sessionId, { type: 'shell-title-history', sessionId, history })
    },
    // onCwd: broadcast to all attached clients + update state
    (sessionId, cwd) => {
      stateManager.updateCwd(sessionId, cwd)
      broadcastToAttached(sessionId, { type: 'cwd', sessionId, cwd })
    },
    // onClaudeSessionHistory: broadcast to all attached clients + update state
    (sessionId, history) => {
      stateManager.updateClaudeSessionHistory(sessionId, history)
      broadcastToAttached(sessionId, { type: 'claude-session-history', sessionId, history })
    },
    // onClaudeState: broadcast to all attached clients + update state
    (sessionId, state) => {
      stateManager.updateClaudeState(sessionId, state)
      broadcastToAttached(sessionId, { type: 'claude-state', sessionId, state })
    }
  )

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')

    const client: ClientConnection = {
      socket,
      attachedSessions: new Set(),
      snapshotSessions: new Set(),
      parser: new LineParser((msg) => {
        handleMessage(client, msg as ClientMessage)
      })
    }

    clients.add(client)
    console.log(`Client connected (${clients.size} total)`)

    socket.on('data', (data) => {
      client.parser.feed(data as string)
    })

    socket.on('close', () => {
      clients.delete(client)
      console.log(`Client disconnected (${clients.size} total)`)
    })

    socket.on('error', (err) => {
      console.error('Client socket error:', err.message)
      clients.delete(client)
    })
  })

  server.listen(SOCKET_PATH, () => {
    console.log(`Terminal server listening on ${SOCKET_PATH}`)
  })

  server.on('error', (err) => {
    console.error('Server error:', err)
    process.exit(1)
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down...')
    snapshotManager.dispose()
    stateManager.persistImmediate()
    sessionManager.destroyAll()
    server.close()
    try {
      fs.unlinkSync(SOCKET_PATH)
    } catch {
      // ignore
    }
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

startServer()
