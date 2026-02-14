import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR, SOCKET_PATH, HOOK_LOG_DIR } from '../shared/protocol'
import type { ClientMessage, ServerMessage } from '../shared/protocol'
import { SessionManager } from './session-manager'
import { setupShellIntegration } from './shell-integration'
import { LineParser } from './line-parser'

interface ClientConnection {
  socket: net.Socket
  attachedSessions: Set<string>
  parser: LineParser
}

const clients = new Set<ClientConnection>()
let sessionManager: SessionManager

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
          claudeSessionHistory: sessionManager.getClaudeSessionHistory(msg.sessionId)
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

  sessionManager = new SessionManager(
    // onData: broadcast to all attached clients
    (sessionId, data) => {
      broadcastToAttached(sessionId, { type: 'data', sessionId, data })
    },
    // onExit: broadcast to all attached clients
    (sessionId, exitCode) => {
      broadcastToAttached(sessionId, { type: 'exit', sessionId, exitCode })
      // Remove from all clients' attached sets
      clients.forEach((client) => {
        client.attachedSessions.delete(sessionId)
      })
    },
    // onTitleHistory: broadcast to all attached clients
    (sessionId, history) => {
      broadcastToAttached(sessionId, { type: 'shell-title-history', sessionId, history })
    },
    // onCwd: broadcast to all attached clients
    (sessionId, cwd) => {
      broadcastToAttached(sessionId, { type: 'cwd', sessionId, cwd })
    },
    // onClaudeSessionHistory: broadcast to all attached clients
    (sessionId, history) => {
      broadcastToAttached(sessionId, { type: 'claude-session-history', sessionId, history })
    }
  )

  const server = net.createServer((socket) => {
    const client: ClientConnection = {
      socket,
      attachedSessions: new Set(),
      parser: new LineParser((msg) => {
        handleMessage(client, msg as ClientMessage)
      })
    }

    clients.add(client)
    console.log(`Client connected (${clients.size} total)`)

    socket.on('data', (data) => {
      client.parser.feed(data.toString())
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
