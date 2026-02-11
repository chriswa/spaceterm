import * as net from 'net'
import * as fs from 'fs'
import { SOCKET_DIR, SOCKET_PATH } from '../shared/protocol'
import type { ClientMessage, ServerMessage } from '../shared/protocol'
import { SessionManager } from './session-manager'
import { LineParser } from './line-parser'

interface ClientConnection {
  socket: net.Socket
  attachedSessions: Set<string>
  parser: LineParser
}

const clients = new Set<ClientConnection>()
let sessionManager: SessionManager

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
      const { sessionId, cols, rows } = sessionManager.create()
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
          scrollback
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
  }
}

function startServer(): void {
  // Ensure socket directory exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true })

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
