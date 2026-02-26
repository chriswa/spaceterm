#!/usr/bin/env tsx
/**
 * spaceterm-cli — CLI for scripts running inside Spaceterm PTYs.
 *
 * Usage:
 *   spaceterm-cli get-ancestors                          # ancestor node IDs (self first)
 *   spaceterm-cli get-node <node-id>                     # full node state as JSON
 *   spaceterm-cli ship-it <node-id> <text>               # send keystrokes to a terminal
 *   spaceterm-cli fork-claude <node-id> <parent-id>      # fork a Claude session, wait for settle
 *   spaceterm-cli subscribe [--events ...] [--nodes ...]  # stream events as JSON lines
 *
 * Environment:
 *   SPACETERM_NODE_ID   — set automatically in PTY sessions
 *   SPACETERM_HOME      — socket directory (default: ~/.spaceterm)
 */

import * as net from 'net'
import { SCRIPTS_SOCKET_PATH } from '../shared/protocol'

// ── Helpers ──────────────────────────────────────────────────────────

interface ServerMsg {
  type: string
  seq?: number
  error?: string
  [key: string]: unknown
}

function sendMsg(socket: net.Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n')
}

/**
 * Connect to the scripts socket, send a message, wait for a reply of the given type.
 */
function oneshot(msg: Record<string, unknown>, replyType: string): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SCRIPTS_SOCKET_PATH)
    socket.setEncoding('utf8')

    let buf = ''
    socket.on('data', (chunk: string) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop()!
      for (const line of lines) {
        if (!line) continue
        try {
          const parsed = JSON.parse(line) as ServerMsg
          if (parsed.type === replyType) {
            resolve(parsed)
            socket.destroy()
          }
        } catch { /* ignore malformed */ }
      }
    })
    socket.on('error', (err) => reject(err))
    socket.on('close', () => reject(new Error('Socket closed before reply')))

    sendMsg(socket, msg)
  })
}

function fireAndForget(msg: Record<string, unknown>): void {
  const socket = net.createConnection(SCRIPTS_SOCKET_PATH)
  socket.on('connect', () => {
    sendMsg(socket, msg)
    socket.end()
  })
  socket.on('error', (err: Error) => fatal(err.message))
}

function fatal(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`)
  process.exit(1)
}

// ── Commands ─────────────────────────────────────────────────────────

async function getAncestors(): Promise<void> {
  const nodeId = process.env.SPACETERM_NODE_ID
  if (!nodeId) fatal('SPACETERM_NODE_ID is not set. Are you running inside a Spaceterm PTY?')

  const reply = await oneshot(
    { type: 'script-get-ancestors', seq: 1, nodeId },
    'script-get-ancestors-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify(reply.ancestors) + '\n')
}

async function getNode(id: string): Promise<void> {
  const reply = await oneshot(
    { type: 'script-get-node', seq: 1, nodeId: id },
    'script-get-node-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify(reply.node) + '\n')
}

async function shipIt(nodeId: string, text: string): Promise<void> {
  const reply = await oneshot(
    { type: 'script-ship-it', seq: 1, nodeId, data: text, submit: true },
    'script-ship-it-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok }) + '\n')
}

async function forkClaude(nodeId: string, parentId: string): Promise<void> {
  const reply = await oneshot(
    { type: 'script-fork-claude', seq: 1, nodeId, parentId },
    'script-fork-claude-result'
  )
  if (reply.error) fatal(reply.error as string)
  process.stdout.write(JSON.stringify({ nodeId: reply.nodeId }) + '\n')
}

function unread(nodeId: string): void {
  fireAndForget({ type: 'script-unread', nodeId })
}

function subscribe(events: string[] | undefined, nodeIds: string[] | undefined): void {
  const socket = net.createConnection(SCRIPTS_SOCKET_PATH)
  socket.setEncoding('utf8')

  let buf = ''
  let acked = false

  socket.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const line of lines) {
      if (!line) continue
      try {
        const msg = JSON.parse(line) as ServerMsg
        if (!acked && msg.type === 'script-subscribe-result') {
          acked = true
          continue
        }
        // Stream events to stdout
        process.stdout.write(line + '\n')
      } catch { /* ignore malformed */ }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`Connection error: ${err.message}\n`)
    process.exit(1)
  })

  socket.on('close', () => {
    process.exit(0)
  })

  const msg: Record<string, unknown> = { type: 'script-subscribe', seq: 1 }
  if (events) msg.events = events
  if (nodeIds) msg.nodeIds = nodeIds
  sendMsg(socket, msg)

  // Clean shutdown on signals
  const cleanup = () => { socket.destroy(); process.exit(0) }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

// ── Argument parsing ─────────────────────────────────────────────────

function printUsage(): void {
  process.stderr.write(`Usage:
  spaceterm-cli get-ancestors                              Get ancestor node IDs
  spaceterm-cli get-node <node-id>                         Get full node state
  spaceterm-cli ship-it <node-id> <text>                   Send keystrokes to terminal
  spaceterm-cli fork-claude <node-id> <parent-id>          Fork a Claude session
  spaceterm-cli unread <node-id>                           Mark a terminal as unread
  spaceterm-cli subscribe [--events e1,e2] [--nodes n1,n2] Stream events
`)
}

const args = process.argv.slice(2)
const command = args[0]

switch (command) {
  case 'get-ancestors':
    getAncestors().catch((err) => fatal(err.message))
    break

  case 'get-node':
    if (!args[1]) { printUsage(); process.exit(1) }
    getNode(args[1]).catch((err) => fatal(err.message))
    break

  case 'ship-it':
    if (!args[1] || !args[2]) { printUsage(); process.exit(1) }
    shipIt(args[1], args[2]).catch((err) => fatal(err.message))
    break

  case 'fork-claude':
    if (!args[1] || !args[2]) { printUsage(); process.exit(1) }
    forkClaude(args[1], args[2]).catch((err) => fatal(err.message))
    break

  case 'unread':
    if (!args[1]) { printUsage(); process.exit(1) }
    unread(args[1])
    break

  case 'subscribe': {
    let events: string[] | undefined
    let nodeIds: string[] | undefined
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--events' && args[i + 1]) {
        events = args[++i].split(',')
      } else if (args[i] === '--nodes' && args[i + 1]) {
        nodeIds = args[++i].split(',')
      }
    }
    subscribe(events, nodeIds)
    break
  }

  case '--help':
  case '-h':
    printUsage()
    break

  default:
    printUsage()
    process.exit(1)
}
