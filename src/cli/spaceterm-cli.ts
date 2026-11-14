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
 *   spaceterm-cli location                               # the user's position, from their phone or Mac
 *   spaceterm-cli add-markdown <parent-id> <content|-> [--x X --y Y]    # new markdown card; prints its id
 *   spaceterm-cli set-markdown <node-id> <content|->                    # replace a markdown card's content
 *   spaceterm-cli add-automation <parent-id> [--trigger T] [--overlap O] [--prompt P|-] [--enabled B] [--x X --y Y]
 *   spaceterm-cli update-automation <node-id> [--trigger T] [--overlap O] [--prompt P|-] [--enabled B]
 *   spaceterm-cli archive <node-id>                                    # archive a card and its whole subtree
 *   spaceterm-cli reparent <node-id> <new-parent-id>                   # put a card (and subtree) under another
 *   spaceterm-cli move <node-id> <x> <y>                               # set one card's position
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
import { AUTOMATION_OVERLAPS } from '../shared/automation'
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
          } else if (parsed.type === 'error') {
            // A refusal before dispatch: a capability the mod lacks, or a
            // message this server is too old to know.
            reject(new Error(parsed.error ?? 'server refused the message'))
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

/**
 * Split arguments into positionals and `--name value` options. Only a name in
 * `names` is an option, so markdown that starts with `---` stays a positional.
 */
function parseOptions(rest: string[], names: readonly string[]): { positional: string[]; options: Map<string, string> } {
  const positional: string[] = []
  const options = new Map<string, string>()
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : undefined
    if (name === undefined || !names.includes(name)) {
      positional.push(rest[i])
      continue
    }
    if (i + 1 >= rest.length) fatal(`--${name} needs a value`)
    options.set(name, rest[++i])
  }
  return { positional, options }
}

/** `-` reads stdin to the end, so long markdown need not survive shell quoting. */
async function textArg(value: string): Promise<string> {
  if (value !== '-') return value
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** `--x`/`--y` as message fields: both or neither. */
function positionFields(options: Map<string, string>): { x?: number; y?: number } {
  const x = options.get('x')
  const y = options.get('y')
  if (x === undefined && y === undefined) return {}
  if (x === undefined || y === undefined) fatal('--x and --y go together')
  const [nx, ny] = [Number(x), Number(y)]
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) fatal('--x and --y must be numbers')
  return { x: nx, y: ny }
}

/** The automation patch fields named on the command line. The server validates them. */
async function automationFields(options: Map<string, string>): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {}
  const trigger = options.get('trigger')
  if (trigger !== undefined) fields.trigger = trigger
  const overlap = options.get('overlap')
  if (overlap !== undefined) fields.overlap = overlap
  const prompt = options.get('prompt')
  if (prompt !== undefined) fields.prompt = await textArg(prompt)
  const enabled = options.get('enabled')
  if (enabled !== undefined) {
    if (enabled !== 'true' && enabled !== 'false') fatal('--enabled is true or false')
    fields.enabled = enabled === 'true'
  }
  return fields
}

const POSITION_OPTIONS = ['x', 'y'] as const
const AUTOMATION_OPTIONS = ['trigger', 'overlap', 'prompt', 'enabled'] as const

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

async function addMarkdown(parentId: string, content: string, options: Map<string, string>): Promise<void> {
  const reply = await oneshot(
    { type: 'script-add-markdown', seq: 1, parentId, content: await textArg(content), ...positionFields(options) },
    'script-add-markdown-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(`${String(reply.nodeId)}\n`)
}

async function setMarkdown(nodeId: string, content: string): Promise<void> {
  const reply = await oneshot(
    { type: 'script-set-markdown', seq: 1, nodeId, content: await textArg(content) },
    'script-set-markdown-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok }) + '\n')
}

async function addAutomation(parentId: string, options: Map<string, string>): Promise<void> {
  const reply = await oneshot(
    { type: 'script-add-automation', seq: 1, parentId, ...(await automationFields(options)), ...positionFields(options) },
    'script-add-automation-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(`${String(reply.nodeId)}\n`)
}

async function updateAutomation(nodeId: string, options: Map<string, string>): Promise<void> {
  const fields = await automationFields(options)
  if (Object.keys(fields).length === 0) fatal(`nothing to change: give one of ${AUTOMATION_OPTIONS.map((o) => `--${o}`).join(', ')}`)
  const reply = await oneshot(
    { type: 'script-update-automation', seq: 1, nodeId, ...fields },
    'script-update-automation-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok }) + '\n')
}

async function archive(nodeId: string): Promise<void> {
  const reply = await oneshot({ type: 'script-archive', seq: 1, nodeId }, 'script-archive-result')
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok, archived: reply.archived }) + '\n')
}

async function reparent(nodeId: string, newParentId: string): Promise<void> {
  const reply = await oneshot({ type: 'script-reparent', seq: 1, nodeId, newParentId }, 'script-reparent-result')
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok }) + '\n')
}

async function move(nodeId: string, x: string, y: string): Promise<void> {
  const [nx, ny] = [Number(x), Number(y)]
  if (x.trim() === '' || y.trim() === '' || !Number.isFinite(nx) || !Number.isFinite(ny)) fatal('<x> and <y> must be numbers')
  const reply = await oneshot({ type: 'script-move', seq: 1, nodeId, x: nx, y: ny }, 'script-move-result')
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify({ ok: reply.ok }) + '\n')
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
 * The `get_user_location` MCP tool, for an agent without it (Codex): the
 * position as JSON, or the reason each device had none.
 */
async function location(): Promise<void> {
  const surfaceId = process.env.SPACETERM_SURFACE_ID
  const reply = await oneshot(
    { type: 'script-get-location', seq: 1, ...(surfaceId ? { surfaceId } : {}) },
    'script-get-location-result'
  )
  if (reply.error) fatal(reply.error)
  process.stdout.write(JSON.stringify(reply.location) + '\n')
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
  spaceterm-cli location                                   The user's position, read on their phone or Mac
  spaceterm-cli add-markdown <parent-id> <content> [--x X --y Y]
                                                           Add a markdown card; prints its id
  spaceterm-cli set-markdown <node-id> <content>           Replace a markdown card's content
  spaceterm-cli add-automation <parent-id> [--trigger T] [--overlap O] [--prompt P] [--enabled true|false] [--x X --y Y]
                                                           Add an automation card; prints its id
  spaceterm-cli update-automation <node-id> [--trigger T] [--overlap O] [--prompt P] [--enabled true|false]
                                                           Change an automation card
  spaceterm-cli archive <node-id>                          Archive a card with its whole subtree, as the
                                                           card's archive button does: children go too,
                                                           terminals in it are shut down, and the subtree
                                                           restores as one from the archive. Not the root.
  spaceterm-cli reparent <node-id> <new-parent-id>         Put a card, with its subtree, under another card
                                                           (or root) without moving it; refuses its own
                                                           descendants
  spaceterm-cli move <node-id> <x> <y>                     Set one card's position; its children stay put

  <content> and --prompt read stdin when given as -. A trigger is a cron
  expression or a custom_ event id; --overlap is ${AUTOMATION_OVERLAPS.join(', ')}.
  An automation card starts switched off unless given --enabled true.

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

  case 'location':
    location().catch((err) => fatal(err.message))
    break

  case 'add-markdown': {
    const { positional, options } = parseOptions(args.slice(1), POSITION_OPTIONS)
    if (positional.length !== 2) { printUsage(); process.exit(1) }
    addMarkdown(positional[0], positional[1], options).catch((err) => fatal(err.message))
    break
  }

  case 'set-markdown': {
    if (args.length !== 3) { printUsage(); process.exit(1) }
    setMarkdown(args[1], args[2]).catch((err) => fatal(err.message))
    break
  }

  case 'add-automation': {
    const { positional, options } = parseOptions(args.slice(1), [...AUTOMATION_OPTIONS, ...POSITION_OPTIONS])
    if (positional.length !== 1) { printUsage(); process.exit(1) }
    addAutomation(positional[0], options).catch((err) => fatal(err.message))
    break
  }

  case 'update-automation': {
    const { positional, options } = parseOptions(args.slice(1), AUTOMATION_OPTIONS)
    if (positional.length !== 1) { printUsage(); process.exit(1) }
    updateAutomation(positional[0], options).catch((err) => fatal(err.message))
    break
  }

  case 'archive':
    if (args.length !== 2) { printUsage(); process.exit(1) }
    archive(args[1]).catch((err) => fatal(err.message))
    break

  case 'reparent':
    if (args.length !== 3) { printUsage(); process.exit(1) }
    reparent(args[1], args[2]).catch((err) => fatal(err.message))
    break

  case 'move':
    if (args.length !== 4) { printUsage(); process.exit(1) }
    move(args[1], args[2], args[3]).catch((err) => fatal(err.message))
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
