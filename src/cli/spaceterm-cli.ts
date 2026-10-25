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
 *   spaceterm-cli protocol                               # version + event set, as JSON
 *   spaceterm-cli capabilities [--json]                  # what optional integrations are present
 *   spaceterm-cli show-images <path> [--caption c] ... [--summary s]  # pictures in Control's transcript
 *   spaceterm-cli fire <custom_event-id> [json-payload]  # trigger automation cards listening for it
 *
 * Environment:
 *   SPACETERM_NODE_ID   — set automatically in PTY sessions
 *   SPACETERM_HOME      — socket directory (default: ~/.spaceterm)
 */

import * as net from 'net'
import {
  HOOKS_SOCKET_PATH,
  SCRIPTS_SOCKET_PATH,
  SCRIPT_EVENTS,
  SCRIPT_PROTOCOL_VERSION,
  type ScriptEvent,
} from '../shared/protocol'
import { probeCapabilities, formatCapabilityReport } from '../server/capabilities'
import { checkImages } from '../claude-code-plugin/mcp-server/show-user-images'

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

/**
 * Fire a custom event at the automation cards whose trigger is `eventId`.
 * The payload is parsed here, so a typo in the JSON fails loudly instead of
 * reaching an agent as a string. Exits non-zero when nothing was listening,
 * since that is almost always a misspelt id.
 */
async function fire(eventId: string, payloadText: string | undefined): Promise<void> {
  let payload: unknown
  if (payloadText !== undefined) {
    try {
      payload = JSON.parse(payloadText)
    } catch (err) {
      fatal(`payload is not JSON: ${(err as Error).message}`)
    }
  }
  const reply = await oneshot(
    { type: 'script-fire-event', seq: 1, eventId, ...(payload !== undefined ? { payload } : {}) },
    'script-fire-event-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ matched: reply.matched }) + '\n')
  if (reply.matched === 0) fatal(`no automation card is listening for ${eventId}`)
}

/**
 * The `show_user_images` MCP tool, for an agent without it (Codex): each
 * `--caption` belongs to the path before it. Checked here, as the tool does,
 * since the hooks socket answers nothing.
 */
function showImages(rest: string[]): void {
  const surfaceId = process.env.SPACETERM_SURFACE_ID
  if (!surfaceId) fatal('SPACETERM_SURFACE_ID is not set: run this inside a Spaceterm surface')
  const images: Array<{ path: string; caption?: string }> = []
  let summary: string | undefined
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--summary') summary = rest[++i]
    else if (rest[i] === '--caption') {
      if (!images.length) fatal('--caption goes after the path it describes')
      images[images.length - 1].caption = rest[++i]
    } else images.push({ path: rest[i] })
  }
  if (!images.length) { printUsage(); process.exit(1) }
  const { ok, problems } = checkImages(images, process.cwd())
  for (const problem of problems) process.stderr.write(`Not shown: ${problem}\n`)
  if (!ok.length) process.exit(1)
  const socket = net.createConnection(HOOKS_SOCKET_PATH, () => {
    socket.end(JSON.stringify({ type: 'show-user-images', surfaceId, images: ok, ...(summary ? { summary } : {}) }) + '\n', () => {
      process.stdout.write(`${ok.length} picture${ok.length === 1 ? '' : 's'} in Control's transcript\n`)
    })
  })
  socket.on('error', (err) => fatal(`Could not reach the server at ${HOOKS_SOCKET_PATH}: ${err.message}`))
}

function unread(nodeId: string): void {
  fireAndForget({ type: 'script-unread', nodeId })
}

/**
 * Ask the server what it speaks.
 *
 * This is the handshake a script should perform before relying on anything
 * else: it reports whether the server serves the version this CLI was built
 * against, and lists every subscribable event, so a script does not have to
 * discover the event set by reading server source it does not have.
 */
async function protocol(): Promise<void> {
  const reply = await oneshot(
    { type: 'script-hello', seq: 1, protocolVersion: SCRIPT_PROTOCOL_VERSION, client: 'spaceterm-cli' },
    'script-hello-result',
  )
  process.stdout.write(JSON.stringify(reply, null, 2) + '\n')
  if (reply.compatible === false) {
    process.stderr.write(`Incompatible: ${reply.error ?? 'server does not serve this protocol version'}\n`)
    process.exit(1)
  }
}

/**
 * Report which optional integrations this machine has, and what each missing
 * one costs.
 *
 * Runs no server request on purpose: every probe reads the local filesystem or
 * shells out, so this answers even when Spaceterm is not running — which is
 * exactly when someone is asking "why did nothing happen?". The same report is
 * written to `~/.spaceterm/electron.log` at server startup.
 *
 * Always exits zero. Every capability probed here is optional, and one of them
 * ("PTY daemon socket") is *expected* to be absent before the app has started
 * — so a non-zero exit would report a perfectly healthy machine as broken,
 * which is the same cry-wolf failure the first version of the pgrep probe had.
 * A caller that needs to gate on a specific capability should parse `--json`
 * and name the one it cares about; different callers care about different ones.
 */
function capabilities(asJson: boolean): void {
  const probed = probeCapabilities()
  if (asJson) {
    process.stdout.write(JSON.stringify(probed, null, 2) + '\n')
  } else {
    for (const line of formatCapabilityReport(probed)) {
      process.stdout.write(line.replace(/^\[capabilities\] /, '') + '\n')
    }
  }
}

function subscribe(events: ScriptEvent[] | undefined, nodeIds: string[] | undefined): void {
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
  spaceterm-cli protocol                                   Protocol version and event set
  spaceterm-cli capabilities [--json]                      Optional integrations present on this machine
  spaceterm-cli show-images <path> [--caption c] ... [--summary s]
                                                           Show the user pictures in Control's transcript
  spaceterm-cli fire <custom_event-id> [json-payload]       Trigger automation cards listening for the event

Events: ${SCRIPT_EVENTS.join(', ')}
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

  case 'protocol':
    protocol().catch((err) => fatal(err.message))
    break

  case 'capabilities':
    capabilities(args.includes('--json'))
    break

  case 'show-images':
    showImages(args.slice(1))
    break

  case 'fire':
    if (!args[1]) { printUsage(); process.exit(1) }
    fire(args[1], args[2]).catch((err) => fatal(err.message))
    break

  case 'subscribe': {
    let events: ScriptEvent[] | undefined
    let nodeIds: string[] | undefined
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--events' && args[i + 1]) {
        const requested = args[++i].split(',')
        // Reject an unknown event here rather than subscribing to nothing and
        // leaving the caller waiting on a stream that will never produce.
        const unknown = requested.filter((e) => !(SCRIPT_EVENTS as readonly string[]).includes(e))
        if (unknown.length > 0) {
          fatal(`Unknown event(s): ${unknown.join(', ')}. Known events: ${SCRIPT_EVENTS.join(', ')}`)
        }
        events = requested as ScriptEvent[]
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
