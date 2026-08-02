import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, spawn } from 'child_process'
import { homedir } from 'os'
import { SOCKET_DIR, SOCKET_PATH, HOOKS_SOCKET_PATH, SCRIPTS_SOCKET_PATH, HOOK_LOG_DIR, CLIENT_PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL_VERSION } from '../shared/protocol'
import { checkProtocolVersion } from '../shared/protocol-handshake'
import type { ClientMessage, IngestMessage, ScriptMessage, ServerMessage, CreateOptions, GhRateLimitData, CameraBounds, ClaudeSessionEntry } from '../shared/protocol'
import { ScriptApi, type ScriptConnection } from './script-api'
import { respawnTerminal, type TerminalRespawnDeps } from './terminal-respawn'
import { RestartRecoveryLedger } from './restart-recovery'
import { recoverSurfaces, type DaemonSessionInfo } from './startup-recovery'
import {
  agentSessionIdFromPayload,
  findValidClaudeSession,
  lastAgentSessionId,
  resolveNonClaudeResumeId
} from './resume-target'
import { assertNever, unhandledVariant } from '../shared/exhaustive'
import type { AgentType } from '../shared/agent-type'
import { createAgentDrivers, driverFor, type AgentDriver, type AgentLaunchSpec } from './agent-drivers'
import { REAL_AGENT_PROVISIONING } from './agent-provisioning'
import { GhRateLimitPoller } from './gh-rate-limit'
import { probeCapabilities, formatCapabilityReport } from './capabilities'
import { asClaudeSessionId, asNodeId, asPtySessionId, nodeIdsOf, nodeIdFromFirstPtySession, type NodeId, type PtySessionId, type ClaudeSessionId } from '../shared/ids'
import { randomUUID } from 'crypto'
import { SessionManager } from './session-manager'
import { serverLog, sanitizeForLog } from './server-log'
import { expandTilde } from './cwd'
import { DaemonClient } from './daemon-client'
import { StateManager } from './state-manager'
import { SnapshotManager } from './snapshot-manager'
import { canFitAt, computePlacement } from './node-placement'
import { terminalPixelSize, directoryFolderWidth, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, DIRECTORY_HEIGHT, FILE_WIDTH, FILE_HEIGHT, TITLE_DEFAULT_WIDTH, TITLE_HEIGHT } from '../shared/node-size'
import { measureCard as nodePixelSize } from '../shared/card-types'
import { setupShellIntegration } from './shell-integration'
import { LineParser } from './line-parser'
import { RingBuffer } from './ring-buffer'
import { SessionFileWatcher } from './session-file-watcher'
import { CodexSessionFileWatcher } from './codex-session-file-watcher'
import { CursorSessionFileWatcher } from './cursor-session-file-watcher'
import { ClaudeStateMachine } from './claude-state'
import { localISOTimestamp } from './timestamp'
import { FileContentManager } from './file-content-manager'
import { GitStatusPoller } from './git-status-poller'
import { PlanCacheManager } from './plan-cache'
import { resolveFilePath, getAncestorCwd } from './path-utils'
import { ancestorsOf, lookupIn } from '../shared/node-ancestry'
import type { NodeData } from '../shared/state'
import { forkSession, computeForkName, sessionFilePath } from './session-fork'
import { parse as shellParse } from 'shell-quote'
import { PotentialErrorDetector } from './auto-continue'
import { SessionTitleSummarizer } from './session-title-summarizer'
import { SummaryChat } from './summary-chat'

/**
 * Claude Code reserves this many tokens as a buffer before triggering autocompact.
 * The effective context window = context_window_size - this buffer.
 * UPDATE THIS when Claude Code changes its compaction threshold.
 */
const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 0

/**
 * How long to wait after a bracketed paste before sending the carriage return
 * that submits it. Claude's input box needs a beat to finish processing the
 * paste, or the return lands as a newline inside the prompt instead.
 */
const SHIP_IT_SUBMIT_DELAY_MS = 1000

/**
 * How long a script-requested fork may take to replay its transcript and fire
 * SessionStart before the request is failed. Generous: a long transcript on a
 * cold filesystem is slow, and a spurious timeout leaves a live terminal the
 * caller believes does not exist.
 */
const FORK_SETTLE_TIMEOUT_MS = 30_000

/** Spaceterm project root (two levels up from src/server/). */

/**
 * Appends a timestamped message to the shared electron.log file so that server-side
 * events are visible alongside main-process logs. Uses async appendFile to avoid
 * blocking the event loop.
 */

/**
 * Build CreateOptions for spawning a Claude Code PTY with full plugin/settings args.
 * Paths are absolute so they work regardless of the spawned process's cwd.
 */
/**
 * Walk the ancestor chain from `startNodeId` upward, collecting context from
 * markdown nodes (non-file-backed content) and file nodes (resolved paths).
 * Returns the accumulated pieces joined with newlines, or undefined if none found.
 */
function gatherAncestorPrompt(nodes: Record<string, NodeData>, startNodeId: NodeId): string | undefined {
  const parts: string[] = []
  for (const node of ancestorsOf(lookupIn(nodes), startNodeId, { includeSelf: true })) {
    if (node.type === 'markdown' && !node.fileBacked && node.content.trim()) {
      parts.push(node.content)
    }
    if (node.type === 'file' && node.filePath) {
      parts.push(resolveFilePath(node.filePath, getAncestorCwd(nodes, node.parentId)))
    }
  }
  // Reverse so outermost ancestors come first
  parts.reverse()
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Parse an extraCliArgs string into an array of string arguments, ignoring shell operators/globs. */
function parseExtraCliArgs(s?: string): string[] {
  if (!s || !s.trim()) return []
  return shellParse(s).filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The agent registry. The argv each CLI needs lives in the driver; what has to
 * exist on disk first lives in agent-provisioning.ts.
 */
const agentDrivers = createAgentDrivers(REAL_AGENT_PROVISIONING)

/** Driver for a surface, defaulting to Claude when no agentType was recorded. */
function agentDriver(agentType: AgentType | undefined): AgentDriver {
  return driverFor(agentDrivers, agentType)
}

/**
 * Decode a client's CreateOptions into the agent it asks for and a launch spec.
 *
 * The wire format carries a per-agent sub-object (`options.codex`,
 * `options.cursor`, `options.claude`); this is the one place that shape is
 * read. Returns undefined for a plain shell terminal, which has no agent.
 */
function agentRequestFrom(
  options: CreateOptions | undefined
): { agentType: AgentType; spec: AgentLaunchSpec } | undefined {
  if (options?.codex) {
    return {
      agentType: 'codex',
      spec: {
        cwd: options.cwd,
        resumeSessionId: options.codex.resumeSessionId,
        forkSessionId: options.codex.forkSessionId,
        prompt: options.codex.prompt,
      },
    }
  }
  if (options?.cursor) {
    return {
      agentType: 'cursor',
      spec: {
        cwd: options.cwd,
        resumeSessionId: options.cursor.resumeSessionId,
        prompt: options.cursor.prompt,
      },
    }
  }
  if (options?.claude) {
    return {
      agentType: 'claude',
      spec: {
        cwd: options.cwd,
        resumeSessionId: options.claude.resumeSessionId,
        prompt: options.claude.prompt,
        appendSystemPrompt: options.claude.appendSystemPrompt,
      },
    }
  }
  return undefined
}

/** Agents whose transcripts are not Claude ~/.claude/projects JSONL. */
function isNonClaudeAgent(agentType: AgentType | undefined): boolean {
  return !agentDriver(agentType).capabilities.claudeTranscript
}

interface ClientConnection {
  id: string
  socket: net.Socket
  attachedSessions: Set<string>
  /** Sessions where this client wants snapshot mode instead of live data */
  snapshotSessions: Set<string>
  /**
   * Sessions mid-attach: live output is queued here instead of being sent,
   * until the serialized state has been captured and sent. Guarantees a clean
   * cut between the serialized snapshot and the live feed (see the 'attach'
   * handler). Absence of an entry means "send live normally".
   */
  attachBuffers: Map<string, ServerMessage[]>
  parser: LineParser
  cameraBounds: CameraBounds | null
}

/**
 * Manual restarts being watched, so a surface whose new CLI arguments turn out
 * to be unlaunchable is reverted rather than archived. See restart-recovery.ts
 * for the three rules and why each one exists.
 */
const restartRecovery = new RestartRecoveryLedger()

// `concurrently --restart-tries` restarts non-zero exits in development. Keep
// this distinct from an ordinary shutdown for the current launcher and any
// future dedicated supervisor.
const SERVER_RESTART_EXIT_CODE = 75
let shutdownServer: ((exitCode?: number) => void) | null = null
let serverRestartScheduled = false

const clients = new Set<ClientConnection>()

let daemonClient: DaemonClient
let sessionManager: SessionManager
let stateManager: StateManager
let snapshotManager: SnapshotManager
let sessionFileWatcher: SessionFileWatcher
let codexSessionFileWatcher: CodexSessionFileWatcher
let cursorSessionFileWatcher: CursorSessionFileWatcher
let fileContentManager: FileContentManager
let gitStatusPoller: GitStatusPoller
let planCacheManager: PlanCacheManager
let claudeStateMachine: ClaudeStateMachine
let potentialErrorDetector: PotentialErrorDetector
let sessionTitleSummarizer: SessionTitleSummarizer
let summaryChat: SummaryChat
let ghRateLimitPoller: GhRateLimitPoller | undefined

/**
 * Point the right transcript watcher at a surface's agent session.
 *
 * Which watcher follows which agent is a per-agent fact, so it is decided once
 * here rather than re-derived at each wiring site. The `assertNever` makes
 * adding an agent a compile error in exactly one place.
 */
function watchAgentTranscript(
  surfaceId: PtySessionId,
  agentType: AgentType | undefined,
  sessionId: ClaudeSessionId,
  cwd: string | undefined,
): void {
  const driver = agentDriver(agentType)
  switch (driver.type) {
    case 'claude':
      // Claude's transcript path is computed from (cwd, sessionId), so without
      // a cwd there is nothing to watch.
      if (cwd) sessionFileWatcher.watch(surfaceId, sessionId, cwd)
      return
    case 'codex':
      codexSessionFileWatcher.watch(surfaceId, sessionId)
      return
    case 'cursor':
      cursorSessionFileWatcher.watch(surfaceId, sessionId)
      return
    default:
      assertNever(driver.type, 'watchAgentTranscript')
  }
}

function surfaceAgentType(surfaceId: PtySessionId): AgentType | undefined {
  // Was `getNodeIdForSession(surfaceId) ?? surfaceId` — falling back to the pty
  // session id as a node id, which only resolves while the two still coincide,
  // i.e. before the terminal's first restart. resolveNodeIdForPtySession scans
  // node data on a map miss instead, which is right in both cases.
  const nodeId = stateManager.resolveNodeIdForPtySession(surfaceId)
  if (!nodeId) return undefined
  const node = stateManager.getNode(nodeId)
  if (node && node.type === 'terminal') return node.agentType
  return undefined
}

function transcriptPathForNode(nodeId: NodeId): string | undefined {
  const node = stateManager.getNode(nodeId)
  if (!node || node.type !== 'terminal') return undefined
  switch (node.agentType) {
    case 'codex': return codexSessionFileWatcher.getFilePath(node.sessionId)
    case 'cursor': return cursorSessionFileWatcher.getFilePath(node.sessionId)
    case 'claude':
    default: return sessionFileWatcher.getFilePath(node.sessionId)
  }
}

/**
 * Cursor often never fires SessionStart. Record chat ids from status-line /
 * UserPromptSubmit / Stop so Extra CLI restart can --resume.
 * Skips PreToolUse — subagents can carry a different conversation_id.
 */
function ensureNonClaudeSessionRecorded(
  surfaceId: PtySessionId,
  payload: Record<string, unknown> | undefined,
  source: string = 'startup',
): void {
  if (!isNonClaudeAgent(surfaceAgentType(surfaceId))) return
  const sid = agentSessionIdFromPayload(payload)
  if (!sid) return
  if (sessionManager.getLastClaudeSessionId(surfaceId) === sid) return
  sessionManager.handleClaudeSessionStart(surfaceId, sid, source)
  if (surfaceAgentType(surfaceId) === 'cursor') cursorSessionFileWatcher.watch(surfaceId, sid)
}

/** After reincarnating a PTY, keep in-memory session history aligned with the node. */
/**
 * The five collaborators `respawnTerminal` needs, bound to this server's
 * singletons. Defined once so all five respawn paths share it — see
 * terminal-respawn.ts for why the order inside matters.
 */
const RESPAWN_DEPS: TerminalRespawnDeps = {
  addSnapshotSession: (sessionId, cols, rows) => snapshotManager.addSession(sessionId, cols, rows),
  seedTitleHistory: (sessionId, titles) => sessionManager.seedTitleHistory(sessionId, titles),
  titleHistoryOf: (nodeId) => {
    const node = stateManager.getNode(nodeId)
    return node?.type === 'terminal' ? node.shellTitleHistory : undefined
  },
  agentSessionHistoryOf: (nodeId) => {
    const node = stateManager.getNode(nodeId)
    return node?.type === 'terminal' ? node.claudeSessionHistory : []
  },
  seedAgentSessionHistory: (sessionId, history) =>
    sessionManager.seedClaudeSessionHistory(sessionId, history as ClaudeSessionEntry[]),
  rebindNode: (nodeId, sessionId, cols, rows) =>
    stateManager.reincarnateTerminal(nodeId, sessionId, cols, rows)
}


function send(socket: net.Socket, msg: ServerMessage): void {
  try {
    socket.write(JSON.stringify(msg) + '\n')
  } catch {
    // Client disconnected
  }
}

/**
 * Tell one client to raise/focus a node. Routes to the first-connected client so
 * the choice is deterministic regardless of which client the OS handed a URL to.
 * `tag` names the caller for the log line. Shared by both focus paths
 * (surface-id and claude-session-id resolution).
 */
function raiseNodeOnClient(focusNodeId: NodeId, tag: string): void {
  const target = clients.values().next().value
  if (!target) {
    serverLog(`[${tag}] No connected clients to raise`)
    return
  }
  serverLog(`[${tag}] node=${focusNodeId.slice(0, 8)} -> client=${target.id.slice(0, 8)}`)
  send(target.socket, { type: 'focus-surface', nodeId: focusNodeId })
}

function broadcastToAttached(sessionId: PtySessionId, msg: ServerMessage): void {
  clients.forEach((client) => {
    if (client.attachedSessions.has(sessionId)) {
      // Mid-attach: queue instead of sending, so live output is held until the
      // serialized state has been captured and sent (see the 'attach' handler).
      const buffer = client.attachBuffers.get(sessionId)
      if (buffer) buffer.push(msg)
      else send(client.socket, msg)
    }
  })
}

/**
 * Record the surface's remaining-context reading and tell attached clients.
 *
 * Split out because it happens from three places (Claude status line, Codex
 * telemetry, and the JSONL watcher's sibling below) and each used to write the
 * value to two owners and rely on a SessionManager callback for the broadcast.
 * The store reports whether the value actually changed, which is what used to
 * gate the broadcast.
 */
function publishContextPercent(sessionId: PtySessionId, contextRemainingPercent: number): void {
  if (!stateManager.updateClaudeContextPercent(sessionId, contextRemainingPercent)) return
  broadcastToAttached(sessionId, { type: 'claude-context', sessionId, contextRemainingPercent })
}

/** {@link publishContextPercent} for the transcript line count. */
function publishSessionLineCount(sessionId: PtySessionId, lineCount: number): void {
  if (!stateManager.updateClaudeSessionLineCount(sessionId, lineCount)) return
  broadcastToAttached(sessionId, { type: 'claude-session-line-count', sessionId, lineCount })
}

function broadcastToAll(msg: ServerMessage): void {
  clients.forEach((client) => {
    send(client.socket, msg)
  })
}

function broadcastToOthers(excludeSocket: net.Socket, msg: ServerMessage): void {
  clients.forEach((client) => {
    if (client.socket !== excludeSocket) {
      send(client.socket, msg)
    }
  })
}

/** Pending fork-settle callbacks: surfaceId → { respond, timeoutId }. */
interface PendingForkSettle {
  respond: (error?: string) => void
  timeoutId: ReturnType<typeof setTimeout>
}
const pendingForkSettles = new Map<string, PendingForkSettle>()

// --- Script socket (scripts.sock) ---

/**
 * The mod-facing API. Everything it is allowed to do is the `ScriptHost`
 * literal below; the dispatch itself lives in script-api.ts, away from the
 * singletons, so it can be tested without a server.
 */
const scriptApi = new ScriptApi({
  getNode: (nodeId) => stateManager.getNode(nodeId),
  getNodeIdForSession: (surfaceId) => stateManager.getNodeIdForSession(surfaceId),
  getNearestTerminalAncestor: (nodeId) => stateManager.getNearestTerminalAncestor(nodeId),
  log: (line) => serverLog(line),

  // The base's entire understanding of a mod's message: which mod, and pass it
  // on. `payload` is not read here or anywhere else in this repo.
  emitMod: (modId, event, payload) => broadcastToAll({ type: 'mod', modId, event, payload }),

  shipIt(sessionId, text, submit) {
    sessionManager.write(sessionId, '\x1b[200~' + text + '\x1b[201~')
    // Mark read; the resulting UserPromptSubmit hook drives the working state.
    claudeStateMachine.handleClientInteract(sessionId)
    // Claude's input box needs a beat to finish processing the paste before it
    // will treat a carriage return as "submit" rather than "newline".
    if (submit) setTimeout(() => sessionManager.write(sessionId, '\r'), SHIP_IT_SUBMIT_DELAY_MS)
  },

  markUnread: (sessionId) => claudeStateMachine.handleClientMarkUnread(sessionId, true),

  resolveTranscript(node) {
    const cwd = node.cwd
    if (!cwd) return { isFork: false }
    // Walk backwards: the newest session whose transcript still exists on disk.
    const history = node.claudeSessionHistory ?? []
    for (let i = history.length - 1; i >= 0; i--) {
      const candidate = sessionFilePath(cwd, history[i].claudeSessionId)
      if (!fs.existsSync(candidate)) continue
      let isFork = false
      try {
        // fork stamps `forkedFrom` on every copied prefix entry; a non-forked
        // (spawned or root) session's transcript never contains it.
        isFork = fs.readFileSync(candidate, 'utf8').includes('"forkedFrom"')
      } catch { /* leave isFork=false when unreadable */ }
      return { path: candidate, isFork }
    }
    return { isFork: false }
  },

  forkClaude(sourceNodeId, parentId) {
    return new Promise<NodeId>((resolve, reject) => {
      const forkNode = stateManager.getNode(sourceNodeId)
      if (!forkNode || forkNode.type !== 'terminal') {
        return reject(new Error(`node ${sourceNodeId} is not a terminal`))
      }
      const history = forkNode.claudeSessionHistory ?? []
      if (history.length === 0) return reject(new Error('no Claude session history'))
      const forkCwd = forkNode.cwd ?? sessionManager.getCwd(forkNode.sessionId)
      if (!forkCwd) return reject(new Error('cannot determine cwd'))

      let sourceClaudeSessionId: ClaudeSessionId | undefined
      for (let i = history.length - 1; i >= 0; i--) {
        if (fs.existsSync(sessionFilePath(forkCwd, history[i].claudeSessionId))) {
          sourceClaudeSessionId = history[i].claudeSessionId
          break
        }
      }
      if (!sourceClaudeSessionId) return reject(new Error('no session transcript file found on disk'))

      const forkName = computeForkName(forkNode.name)
      const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId)
      const forkOptions = agentDrivers.claude.buildCreateOptions({
        cwd: forkCwd,
        resumeSessionId: newClaudeSessionId,
        extraArgs: parseExtraCliArgs(forkNode.extraCliArgs)
      })
      const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
      snapshotManager.addSession(forkPtyId, forkCols, forkRows)

      // Place the new terminal below the specified parent, not the source node.
      const forkPos = computePlacement(stateManager.getState().nodes, parentId, terminalPixelSize(forkCols, forkRows))
      stateManager.createTerminal({
        sessionId: forkPtyId, parentId, x: forkPos.x, y: forkPos.y, cols: forkCols, rows: forkRows,
        cwd: forkCwd, initialTitleHistory: forkNode.shellTitleHistory, name: forkName, insertAfterNodeId: sourceNodeId
      })
      if (forkNode.shellTitleHistory?.length) {
        sessionManager.seedTitleHistory(forkPtyId, forkNode.shellTitleHistory)
      }

      // The pty exists but Claude has not replayed the transcript yet. Settle
      // is signalled by the SessionStart hook, or by the pty exiting first.
      let settled = false
      const respond = (error?: string): void => {
        if (settled) return
        settled = true
        pendingForkSettles.delete(forkPtyId)
        if (error) reject(new Error(error))
        // createTerminal seeds the node id from the pty session id, so for a
        // terminal that has never restarted the two are the same value.
        else resolve(nodeIdFromFirstPtySession(forkPtyId))
      }
      const timeoutId = setTimeout(() => respond('Timed out waiting for session to settle'), FORK_SETTLE_TIMEOUT_MS)
      pendingForkSettles.set(forkPtyId, { respond, timeoutId })

      serverLog(`[script-fork-claude] Forked terminal ${sourceNodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (parent ${parentId.slice(0, 8)}), waiting for settle...`)
    })
  }
})

/**
 * Bridge one `net.Socket` to the transport-free `ScriptConnection` the API
 * speaks. Writes to a disconnected socket are swallowed: a script that hung up
 * mid-command is normal, not an error.
 */
function scriptConnectionFor(socket: net.Socket): ScriptConnection {
  return {
    send(message) {
      try {
        socket.write(JSON.stringify(message) + '\n')
      } catch { /* disconnected */ }
    },
    close() {
      socket.end()
    },
    onDisconnect(fn) {
      socket.on('close', fn)
      socket.on('error', fn)
    }
  }
}

/** Handle fire-and-forget messages from the hooks socket. No response is sent. */
function handleIngestMessage(msg: IngestMessage): void {
  switch (msg.type) {
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

      const hookTime = typeof msg.ts === 'number' ? msg.ts : Date.now()

      // Delegate state transition logic to the state machine
      claudeStateMachine.handleHook(msg.surfaceId, hookType, msg.payload as Record<string, unknown>, hookTime)

      // Process SessionStart hooks for agent session history tracking
      // (session lifecycle management stays here — not state machine concern)
      if (hookType === 'SessionStart' && msg.payload && typeof msg.payload === 'object') {
        const claudeSessionId = 'session_id' in msg.payload ? asClaudeSessionId(String(msg.payload.session_id)) : ''
        const source = 'source' in msg.payload ? String(msg.payload.source) : 'startup'
        if (claudeSessionId) {
          sessionManager.handleClaudeSessionStart(msg.surfaceId, claudeSessionId, source)
          watchAgentTranscript(
            msg.surfaceId,
            surfaceAgentType(msg.surfaceId),
            claudeSessionId,
            sessionManager.getCwd(msg.surfaceId),
          )
        }
      }

      // Cursor rarely emits SessionStart — record chat id from turn boundaries.
      if (
        (hookType === 'UserPromptSubmit' || hookType === 'Stop') &&
        msg.payload &&
        typeof msg.payload === 'object'
      ) {
        ensureNonClaudeSessionRecorded(
          msg.surfaceId,
          msg.payload as Record<string, unknown>,
          hookType === 'Stop' ? 'resume' : 'startup',
        )
      }

      // Resolve pending fork-settle if this surface has one waiting
      if (hookType === 'SessionStart') {
        const pending = pendingForkSettles.get(msg.surfaceId)
        if (pending) {
          clearTimeout(pending.timeoutId)
          pendingForkSettles.delete(msg.surfaceId)
          pending.respond()
        }
      }

      // Generate auto-summary title on UserPromptSubmit (fire-and-forget).
      // Summarizer parses Claude JSONL only — skip for Cursor/Codex surfaces.
      if (hookType === 'UserPromptSubmit' && msg.payload && typeof msg.payload === 'object') {
        if (!isNonClaudeAgent(surfaceAgentType(msg.surfaceId))) {
          const transcriptPath = 'transcript_path' in msg.payload ? String(msg.payload.transcript_path) : ''
          const claudeSessionId = 'session_id' in msg.payload ? asClaudeSessionId(String(msg.payload.session_id)) : ''
          if (transcriptPath && claudeSessionId) {
            sessionTitleSummarizer.summarize(msg.surfaceId, transcriptPath, claudeSessionId)
          }
        }
      }
      break
    }

    case 'voice-command': {
      const text = msg.text.trim()
      if (text) void summaryChat.followUp(text)
      break
    }

    case 'emit-markdown': {
      const parentNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!parentNodeId) {
        serverLog(`[emit-markdown] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      const emPos = computePlacement(
        stateManager.getState().nodes,
        parentNodeId,
        { width: MARKDOWN_DEFAULT_WIDTH, height: MARKDOWN_DEFAULT_HEIGHT }
      )
      stateManager.createMarkdown(parentNodeId, emPos.x, emPos.y, msg.content)
      break
    }

    case 'emit-markdown-on-parent': {
      const callerNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!callerNodeId) {
        console.error(`[emit-markdown-on-parent] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      const targetNodeId = stateManager.getNearestTerminalAncestor(callerNodeId)
      if (!targetNodeId) {
        console.error(`[emit-markdown-on-parent] No terminal ancestor for ${callerNodeId.slice(0, 8)}`)
        break
      }
      const empPos = computePlacement(
        stateManager.getState().nodes,
        targetNodeId,
        { width: MARKDOWN_DEFAULT_WIDTH, height: MARKDOWN_DEFAULT_HEIGHT }
      )
      stateManager.createMarkdown(targetNodeId, empPos.x, empPos.y, msg.content)
      break
    }

    case 'spawn-claude-surface': {
      const spawnParentNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!spawnParentNodeId) {
        console.error(`[spawn-claude-surface] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      try {
        const spawnCwd = sessionManager.getCwd(msg.surfaceId)
        const ancestorContext = gatherAncestorPrompt(stateManager.getState().nodes, spawnParentNodeId)
        const fullPrompt = ancestorContext ? `${ancestorContext}\n${msg.prompt}` : msg.prompt
        const spawnOptions = agentDrivers.claude.buildCreateOptions({ cwd: spawnCwd, prompt: fullPrompt })
        const { sessionId: spawnSessionId, cols: spawnCols, rows: spawnRows } = sessionManager.create(spawnOptions)
        snapshotManager.addSession(spawnSessionId, spawnCols, spawnRows)
        const spawnPos = computePlacement(stateManager.getState().nodes, spawnParentNodeId, terminalPixelSize(spawnCols, spawnRows))
        stateManager.createTerminal({
          sessionId: spawnSessionId, parentId: spawnParentNodeId, x: spawnPos.x, y: spawnPos.y,
          cols: spawnCols, rows: spawnRows, cwd: spawnCwd, name: msg.title
        })
        console.log(`[spawn-claude-surface] Created terminal "${msg.title}" parented to ${spawnParentNodeId.slice(0, 8)}`)
      } catch (err: any) {
        console.error(`[spawn-claude-surface] Failed: ${err.message}`)
      }
      break
    }

    case 'fork-claude-surface': {
      const forkSrcNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!forkSrcNodeId) {
        console.error(`[fork-claude-surface] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      try {
        const forkSrcNode = stateManager.getNode(forkSrcNodeId)
        if (!forkSrcNode || forkSrcNode.type !== 'terminal') {
          console.error(`[fork-claude-surface] Node ${forkSrcNodeId} is not a terminal`)
          break
        }
        const history = forkSrcNode.claudeSessionHistory ?? []
        if (history.length === 0) {
          console.error(`[fork-claude-surface] No Claude session history for ${forkSrcNodeId.slice(0, 8)}`)
          break
        }
        const forkCwd = forkSrcNode.cwd ?? sessionManager.getCwd(forkSrcNode.sessionId)
        if (!forkCwd) {
          console.error(`[fork-claude-surface] Cannot determine cwd for ${forkSrcNodeId.slice(0, 8)}`)
          break
        }
        let sourceClaudeSessionId: ClaudeSessionId | undefined
        for (let i = history.length - 1; i >= 0; i--) {
          if (fs.existsSync(sessionFilePath(forkCwd, history[i].claudeSessionId))) {
            sourceClaudeSessionId = history[i].claudeSessionId
            break
          }
        }
        if (!sourceClaudeSessionId) {
          console.error(`[fork-claude-surface] No session transcript found on disk for ${forkSrcNodeId.slice(0, 8)}`)
          break
        }

        const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId)
        const forkOptions = agentDrivers.claude.buildCreateOptions({ cwd: forkCwd, resumeSessionId: newClaudeSessionId, prompt: msg.prompt, extraArgs: parseExtraCliArgs(forkSrcNode.extraCliArgs) })
        const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
        snapshotManager.addSession(forkPtyId, forkCols, forkRows)

        const forkPos = computePlacement(stateManager.getState().nodes, forkSrcNodeId, terminalPixelSize(forkCols, forkRows))
        stateManager.createTerminal({
          sessionId: forkPtyId, parentId: forkSrcNodeId, x: forkPos.x, y: forkPos.y,
          cols: forkCols, rows: forkRows, cwd: forkCwd,
          initialTitleHistory: forkSrcNode.shellTitleHistory, name: msg.title
        })
        if (forkSrcNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(forkPtyId, forkSrcNode.shellTitleHistory)
        }

        console.log(`[fork-claude-surface] Forked "${msg.title}" from ${forkSrcNodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (claude session ${newClaudeSessionId.slice(0, 8)})`)
      } catch (err: any) {
        console.error(`[fork-claude-surface] Failed: ${err.message}`)
      }
      break
    }

    case 'spaceterm-broadcast': {
      const broadcastNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!broadcastNodeId) {
        console.error(`[spaceterm-broadcast] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      scriptApi.broadcast('broadcast', broadcastNodeId, {
        type: 'broadcast',
        nodeId: broadcastNodeId,
        surfaceId: msg.surfaceId,
        content: msg.content,
      })
      break
    }

    case 'play-sound': {
      broadcastToAll({ type: 'play-sound', sound: msg.sound })
      break
    }

    case 'speak': {
      broadcastToAll({ type: 'speak', text: msg.text })
      break
    }

    case 'status-line': {
      // Delegate state logic (stale timer reset, stuck recovery) to state machine
      claudeStateMachine.handleStatusLine(msg.surfaceId)

      const logEntry =
        JSON.stringify({
          timestamp: localISOTimestamp(),
          type: 'status-line',
          payload: msg.payload
        }) + '\n'
      const slLogPath = path.join(HOOK_LOG_DIR, `${msg.surfaceId}.jsonl`)
      fs.appendFile(slLogPath, logEntry, (err) => {
        if (err) console.error(`Failed to write status-line log: ${err.message}`)
      })

      // Extract context window remaining %.
      // Cursor statusLine provides remaining_percentage / used_percentage directly.
      // Claude statusLine provides current_usage + context_window_size.
      const cw = msg.payload?.context_window as Record<string, unknown> | undefined
      if (cw) {
        let remainingPercent: number | null = null
        const cursorRemaining = cw.remaining_percentage
        const cursorUsed = cw.used_percentage
        if (typeof cursorRemaining === 'number' && Number.isFinite(cursorRemaining)) {
          remainingPercent = cursorRemaining
        } else if (typeof cursorUsed === 'number' && Number.isFinite(cursorUsed)) {
          remainingPercent = 100 - cursorUsed
        } else {
          const usage = cw.current_usage as Record<string, number> | undefined
          const contextWindowSize = cw.context_window_size as number | undefined
          if (usage && contextWindowSize) {
            const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
              + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
            const effectiveSize = contextWindowSize - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS
            remainingPercent = (1 - totalTokens / effectiveSize) * 100
          }
        }
        if (remainingPercent != null) {
          publishContextPercent(msg.surfaceId, remainingPercent)
        }
      }

      // Extract model display name (Claude + Cursor share this shape)
      const model = msg.payload?.model as { display_name?: string } | undefined
      if (model?.display_name) {
        stateManager.updateClaudeModel(msg.surfaceId, model.display_name)
      }

      // Cursor (and similar) often skip SessionStart; statusLine still carries session_id.
      if (msg.payload && typeof msg.payload === 'object') {
        ensureNonClaudeSessionRecorded(msg.surfaceId, msg.payload as Record<string, unknown>, 'startup')
      }
      break
    }

    default: {
      // The hooks socket is fire-and-forget, so there is nobody to reply to —
      // without this branch an unhandled ingest message vanished silently.
      const unknownType = unhandledVariant(msg)
      console.error(`[ingest] Unknown message type: ${unknownType}`)
      break
    }
  }
}

/** What this build serves on the client socket. */
const CLIENT_PROTOCOL_RANGE = { min: MIN_CLIENT_PROTOCOL_VERSION, current: CLIENT_PROTOCOL_VERSION }

function handleMessage(client: ClientConnection, msg: ClientMessage): void {
  switch (msg.type) {
    case 'client-hello': {
      const { compatible, error } = checkProtocolVersion(msg.protocolVersion, CLIENT_PROTOCOL_RANGE)
      const who = msg.client ?? 'unknown client'
      serverLog(
        compatible
          ? `[client] ${who} connected on protocol v${msg.protocolVersion}`
          : `[client] ${who} rejected: ${error}`
      )
      send(client.socket, {
        type: 'client-hello-result',
        seq: msg.seq,
        compatible,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        minProtocolVersion: MIN_CLIENT_PROTOCOL_VERSION,
        ...(compatible ? {} : { error })
      })
      break
    }

    case 'server-restart': {
      if (serverRestartScheduled) {
        send(client.socket, { type: 'server-error', seq: msg.seq, message: 'Server restart is already in progress' })
        break
      }
      if (!shutdownServer) {
        send(client.socket, { type: 'server-error', seq: msg.seq, message: 'Server restart is unavailable during startup' })
        break
      }
      serverRestartScheduled = true
      serverLog('[restart] Restart requested by client')
      send(client.socket, { type: 'server-restarted', seq: msg.seq })
      // Give the acknowledgement a chance to leave the Unix socket before the
      // graceful shutdown closes all client connections.
      setTimeout(() => shutdownServer?.(SERVER_RESTART_EXIT_CODE), 25)
      break
    }

    case 'summary-chat-start': {
      const node = stateManager.getNode(msg.nodeId)
      if (!node || node.type !== 'terminal') {
        serverLog(`[summary-chat] rejected node=${msg.nodeId.slice(0, 8)} (not a terminal)`)
        broadcastToAll({ type: 'summary-chat-status', nodeId: msg.nodeId, state: 'error', message: 'Focus an agent terminal before starting Summary Chat.' })
        break
      }
      void summaryChat.start(
        node.id,
        transcriptPathForNode(node.id),
        node.claudeSessionHistory.at(-1)?.claudeSessionId,
      )
      break
    }
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
      const sessionId = msg.sessionId

      // Send cached plan files after the 'attached' message (deferred into the
      // serialize callback below) so ordering is preserved.
      const sendPlanCache = () => {
        const claudeSessionId = sessionManager.getLastClaudeSessionId(sessionId)
        if (!claudeSessionId) return
        const planFiles = planCacheManager.getVersions(claudeSessionId)
        if (planFiles.length >= 2) {
          send(client.socket, {
            type: 'plan-cache-update',
            sessionId,
            count: planFiles.length,
            files: planFiles
          })
        }
      }

      // We replay terminal state by serializing the server-side headless
      // emulator (scrollback + screen + modes + alt buffer) rather than the
      // truncated raw byte buffer, which loses the one-time mode-setup
      // sequences for long-running TUI sessions.
      //
      // The cut between serialized state and live feed must be exact. These two
      // statements run in one synchronous block, so no onData chunk can slip
      // between them: from here on, live output for this session is queued in
      // attachBuffers (see broadcastToAttached) instead of being sent, and the
      // drain barrier inside serializeForAttach captures exactly the data
      // parsed before this point.
      client.attachedSessions.add(sessionId)
      const liveBuffer: ServerMessage[] = []
      client.attachBuffers.set(sessionId, liveBuffer)

      snapshotManager.serializeForAttach(sessionId, (state) => {
        // The client may have disconnected during the (sub-frame) drain.
        if (!clients.has(client)) return

        send(client.socket, {
          type: 'attached',
          seq: msg.seq,
          sessionId,
          scrollback: state ?? '',
          claudeContextPercent: stateManager.getClaudeContextPercent(sessionId) ?? undefined,
          claudeSessionLineCount: stateManager.getClaudeSessionLineCount(sessionId) ?? undefined
        })

        // Stop buffering and flush queued live output in order — everything
        // after the serialized cut. Subsequent output goes live normally.
        client.attachBuffers.delete(sessionId)
        for (const queued of liveBuffer) send(client.socket, queued)

        sendPlanCache()
      })
      break
    }

    case 'detach': {
      client.attachedSessions.delete(msg.sessionId)
      client.attachBuffers.delete(msg.sessionId)
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
      // Interacting with the terminal only marks it read — state is derived from
      // hooks + transcript, not keystrokes.
      claudeStateMachine.handleClientInteract(msg.sessionId)
      break
    }

    case 'resize': {
      sessionManager.resize(msg.sessionId, msg.cols, msg.rows)
      break
    }

    // --- Node state mutation messages ---

    case 'node-sync-request': {
      send(client.socket, { type: 'sync-state', seq: msg.seq, state: stateManager.getState() })
      // Send file content for all watched file-backed markdowns
      for (const nodeId of fileContentManager.getWatchedNodeIds()) {
        const fileContent = fileContentManager.getContent(nodeId)
        if (fileContent !== null) {
          send(client.socket, { type: 'file-content', nodeId, content: fileContent })
        }
      }
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
      // Stop file watching if this is a file-backed markdown
      fileContentManager.stopWatching(msg.nodeId)
      gitStatusPoller.removeNode(msg.nodeId)
      stateManager.archiveNode(msg.nodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-unarchive': {
      // Compute auto-placement for the unarchived node
      const archivedData = stateManager.peekArchivedNode(msg.parentNodeId, msg.archivedNodeId)
      let unarchivePosition: { x: number; y: number } | undefined
      if (archivedData) {
        const size = nodePixelSize(archivedData)
        const nodes = stateManager.getState().nodes
        if (canFitAt(nodes, { x: archivedData.x, y: archivedData.y }, size)) {
          unarchivePosition = { x: archivedData.x, y: archivedData.y }
        } else {
          unarchivePosition = computePlacement(nodes, msg.parentNodeId, size)
        }
      }

      stateManager.unarchiveNode(msg.parentNodeId, msg.archivedNodeId, unarchivePosition)

      // Auto-reincarnate if the restored node is a terminal
      const restoredNode = stateManager.getNode(msg.archivedNodeId)
      if (restoredNode && restoredNode.type === 'terminal') {
        const history = restoredNode.claudeSessionHistory ?? []
        const agentType = restoredNode.agentType
        const isCursorOrCodex = !agentDriver(agentType).capabilities.claudeTranscript
        const resumeId = isCursorOrCodex
          ? resolveNonClaudeResumeId(restoredNode)
          : findValidClaudeSession(history, restoredNode.cwd)
        // Claude still requires a resumable JSONL session. Cursor/Codex can come
        // back fresh if we never recorded a chat id (same class of bug as restart).
        if (!resumeId && !isCursorOrCodex) {
          serverLog(`[unarchive] No valid Claude session for ${msg.archivedNodeId.slice(0, 8)}; re-archiving`)
          stateManager.archiveTerminal(msg.archivedNodeId)
          send(client.socket, { type: 'mutation-ack', seq: msg.seq })
          break
        }
        try {
          // Protect against immediate PTY exit re-archiving (bad resume / slow start).
          stateManager.markReviving(msg.archivedNodeId)
          const restoreExtra = parseExtraCliArgs(restoredNode.extraCliArgs)
          const restoreOptions = {
            ...agentDriver(agentType).buildCreateOptions({
              cwd: restoredNode.cwd,
              resumeSessionId: resumeId,
              extraArgs: restoreExtra,
            }),
            nodeId: msg.archivedNodeId,
          }
          const { sessionId: newPtyId, cols, rows } = respawnTerminal(
            msg.archivedNodeId, () => sessionManager.create(restoreOptions), RESPAWN_DEPS)
          client.attachedSessions.add(newPtyId)
          send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols, rows })
          const agentLabel = agentDriver(agentType).label
          serverLog(`[unarchive] Reincarnated terminal ${msg.archivedNodeId.slice(0, 8)} with ${agentLabel} session ${resumeId ? resumeId.slice(0, 8) : '(fresh)'}`)
        } catch (err: any) {
          console.error(`[unarchive] Failed to reincarnate terminal ${msg.archivedNodeId.slice(0, 8)}: ${err.message}`)
          stateManager.clearReviving(msg.archivedNodeId)
          stateManager.archiveTerminal(msg.archivedNodeId)
          send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        }
      } else {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      }
      break
    }

    case 'node-archive-delete': {
      stateManager.deleteArchivedNode(msg.parentNodeId, msg.archivedNodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'undo-buffer-push': {
      stateManager.pushUndoEntry(msg.entry)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'undo-buffer-set-cursor': {
      stateManager.setUndoCursor(msg.cursor)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-bring-to-front': {
      stateManager.bringToFront(msg.nodeId)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-reparent': {
      const reparentNode = stateManager.getNode(msg.nodeId)
      if (reparentNode?.type === 'markdown' && reparentNode.fileBacked) {
        const newParent = stateManager.getNode(msg.newParentId)
        fileContentManager.stopWatching(msg.nodeId)
        stateManager.reparentNode(msg.nodeId, msg.newParentId)
        if (newParent?.type === 'file') {
          const rpCwd = getAncestorCwd(stateManager.getState().nodes, newParent.id)
          const rpPath = resolveFilePath(newParent.filePath, rpCwd)
          fileContentManager.startWatching(msg.nodeId, newParent.id, rpPath)
        }
        // If new parent is not a file node, node stays unwatched (error state on client)
      } else {
        stateManager.reparentNode(msg.nodeId, msg.newParentId)
      }
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'node-swap-parent-child': {
      const swapParent = stateManager.getNode(msg.nodeId)
      const swapChild = stateManager.getNode(msg.childId)

      if (!swapParent || !swapChild || swapChild.parentId !== msg.nodeId || msg.nodeId === 'root') {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        break
      }

      // Collect all nodes whose parentId will change
      const affectedIds = [msg.nodeId, msg.childId]
      for (const node of Object.values(stateManager.getState().nodes)) {
        if (node.parentId === msg.childId) {
          affectedIds.push(node.id)
        }
      }

      // Stop file watchers for affected file-backed markdown nodes
      for (const id of affectedIds) {
        const node = stateManager.getNode(id)
        if (node?.type === 'markdown' && node.fileBacked) {
          fileContentManager.stopWatching(id)
        }
      }

      stateManager.swapParentChild(msg.nodeId, msg.childId)

      // Restart file watchers under new parents
      for (const id of affectedIds) {
        const node = stateManager.getNode(id)
        if (node?.type === 'markdown' && node.fileBacked) {
          const newParent = stateManager.getNode(node.parentId)
          if (newParent?.type === 'file') {
            const cwd = getAncestorCwd(stateManager.getState().nodes, newParent.id)
            const filePath = resolveFilePath(newParent.filePath, cwd)
            fileContentManager.startWatching(id, newParent.id, filePath)
          }
        }
      }

      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'terminal-create': {
      try {
        const request = agentRequestFrom(msg.options)
        const agentType: AgentType | undefined = request?.agentType
        let options: CreateOptions | undefined
        if (request) {
          const spec: AgentLaunchSpec = request.agentType === 'claude'
            // A Claude surface with no explicit prompt inherits one from its
            // markdown ancestors.
            ? { ...request.spec, prompt: request.spec.prompt ?? gatherAncestorPrompt(stateManager.getState().nodes, msg.parentId) }
            : request.spec
          options = agentDrivers[request.agentType].buildCreateOptions(spec)
        } else {
          options = msg.options
        }
        const { sessionId, cols, rows } = sessionManager.create(options)
        snapshotManager.addSession(sessionId, cols, rows)
        const cwd = sessionManager.getCwd(sessionId)
        let posX: number
        let posY: number
        if (msg.x != null && msg.y != null) {
          posX = msg.x
          posY = msg.y
        } else {
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, terminalPixelSize(cols, rows))
          posX = pos.x
          posY = pos.y
        }
        const parentNode = stateManager.getNode(msg.parentId)
        console.log(`[terminal-create] parent=${msg.parentId.slice(0, 8)} parentPos=(${parentNode?.x}, ${parentNode?.y}) parentSize=(${parentNode?.type === 'markdown' ? parentNode.width : '?'}x${parentNode?.type === 'markdown' ? parentNode.height : '?'}) termPos=(${posX}, ${posY}) clientPos=(${msg.x}, ${msg.y}) initialInput=${!!msg.initialInput}`)
        stateManager.createTerminal({
          sessionId, parentId: msg.parentId, x: posX, y: posY, cols, rows, cwd,
          initialTitleHistory: msg.initialTitleHistory, name: msg.initialName, agentType
        })
        if (msg.initialTitleHistory?.length) {
          sessionManager.seedTitleHistory(sessionId, msg.initialTitleHistory)
        }
        send(client.socket, { type: 'created', seq: msg.seq, sessionId, cols, rows })
        if (msg.initialInput) {
          setTimeout(() => {
            sessionManager.write(sessionId, msg.initialInput! + '\n')
          }, 100)
        }
      } catch (err: any) {
        console.error(`terminal-create failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `terminal-create failed: ${err.message}` })
      }
      break
    }

    case 'terminal-resize': {
      const tNode = stateManager.getNode(msg.nodeId)
      // Previously fell back to using the node id as a pty id. That can only
      // ever name a live pty when node id == pty id, in which case getNode
      // would have succeeded — so the fallback was reachable only when there is
      // nothing to resize. Skipping is what it was already effectively doing.
      if (!tNode || tNode.type !== 'terminal') {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        break
      }
      const ptyId = tNode.sessionId
      sessionManager.resize(ptyId, msg.cols, msg.rows)
      snapshotManager.resize(ptyId, msg.cols, msg.rows)
      stateManager.updateTerminalSize(ptyId, msg.cols, msg.rows)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'terminal-reincarnate': {
      try {
        const rNode = stateManager.getNode(msg.nodeId)
        if (!rNode || rNode.type !== 'terminal' || rNode.alive) {
          send(client.socket, { type: 'mutation-ack', seq: msg.seq })
          break
        }
        const rExtraArgs = parseExtraCliArgs(rNode.extraCliArgs)
        const rRequest = agentRequestFrom(msg.options)
        let rOptions: CreateOptions | undefined
        if (rRequest) {
          // The surface's Extra CLI arguments apply to every agent. The Claude
          // branch used to drop them here while restart, unarchive and revive
          // all passed them — an inconsistency that only survived because each
          // path built its own command line.
          rOptions = agentDrivers[rRequest.agentType].buildCreateOptions({ ...rRequest.spec, extraArgs: rExtraArgs })
        } else if (rNode.agentType && !agentDriver(rNode.agentType).capabilities.claudeTranscript) {
          // Revive a Cursor/Codex surface with no explicit payload (e.g. an
          // empty reincarnate) by resuming its most recent recorded chat.
          rOptions = agentDriver(rNode.agentType).buildCreateOptions({
            cwd: msg.options?.cwd ?? rNode.cwd,
            resumeSessionId: lastAgentSessionId(rNode.claudeSessionHistory ?? []),
            extraArgs: rExtraArgs,
          })
        } else {
          rOptions = msg.options ? { ...msg.options } : undefined
        }
        // Pass stable nodeId so SPACETERM_NODE_ID survives reincarnation
        rOptions = { ...rOptions, nodeId: msg.nodeId }
        const { sessionId: newPtyId, cols: rCols, rows: rRows } = respawnTerminal(
          msg.nodeId, () => sessionManager.create(rOptions), RESPAWN_DEPS)
        stateManager.setAlert(msg.nodeId, 'launch-failed', null)
        // Auto-attach client to the new PTY session
        client.attachedSessions.add(newPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols: rCols, rows: rRows })
      } catch (err: any) {
        console.error(`terminal-reincarnate failed: ${err.message}`)
        stateManager.setAlert(msg.nodeId, 'launch-failed', `Could not revive this surface: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `terminal-reincarnate failed: ${err.message}` })
      }
      break
    }

    case 'directory-add': {
      try {
        let posX: number
        let posY: number
        if (msg.x != null && msg.y != null) {
          posX = msg.x
          posY = msg.y
        } else {
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: directoryFolderWidth(msg.cwd), height: DIRECTORY_HEIGHT })
          posX = pos.x
          posY = pos.y
        }
        const dirNode = stateManager.createDirectory(msg.parentId, posX, posY, msg.cwd)
        gitStatusPoller.pollNode(dirNode.id)
        send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: dirNode.id })
      } catch (err: any) {
        console.error(`directory-add failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `directory-add failed: ${err.message}` })
      }
      break
    }

    case 'directory-cwd': {
      try {
        stateManager.updateDirectoryCwd(msg.nodeId, msg.cwd)
        gitStatusPoller.pollNode(msg.nodeId)
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      } catch (err: any) {
        console.error(`directory-cwd failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `directory-cwd failed: ${err.message}` })
      }
      break
    }

    case 'directory-git-fetch': {
      const dirNode = stateManager.getNode(msg.nodeId)
      if (!dirNode || dirNode.type !== 'directory') {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        break
      }
      const fetchCwd = resolveFilePath(dirNode.cwd)
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd: fetchCwd, timeout: 5000 }, (topErr, topOut) => {
        const repoRoot = topErr ? fetchCwd : topOut.trim()
        execFile('git', ['fetch'], { cwd: repoRoot, timeout: 15000 }, () => {
          gitStatusPoller.pollNode(msg.nodeId)
        })
      })
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'directory-wt-spawn': {
      const wtDirNode = stateManager.getNode(msg.nodeId)
      if (!wtDirNode || wtDirNode.type !== 'directory') {
        send(client.socket, { type: 'server-error', message: 'Not a directory node' })
        break
      }
      const wtCwd = resolveFilePath(wtDirNode.cwd)
      const wtProc = spawn('wt-spawn', [msg.branchName], { cwd: wtCwd })
      let wtBuffer = ''
      let wtResponded = false

      wtProc.stdout.on('data', (chunk: Buffer) => {
        if (wtResponded) return
        wtBuffer += chunk.toString()
        const nlIdx = wtBuffer.indexOf('\n')
        if (nlIdx !== -1) {
          wtResponded = true
          const wtPath = wtBuffer.slice(0, nlIdx).trim()
          const home = homedir()
          let normalizedCwd = wtPath
          if (wtPath === home) normalizedCwd = '~'
          else if (wtPath.startsWith(home + '/')) normalizedCwd = '~' + wtPath.slice(home.length)

          const pos = computePlacement(stateManager.getState().nodes, msg.nodeId,
            { width: directoryFolderWidth(normalizedCwd), height: DIRECTORY_HEIGHT })
          const newDir = stateManager.createDirectory(msg.nodeId, pos.x, pos.y, normalizedCwd)
          gitStatusPoller.pollNode(newDir.id)
          send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: newDir.id })

          wtProc.on('close', () => {
            gitStatusPoller.pollNode(newDir.id)
          })
        }
      })

      wtProc.on('error', (err: Error) => {
        if (!wtResponded) {
          wtResponded = true
          send(client.socket, { type: 'server-error', message: `wt-spawn failed: ${err.message}` })
        }
      })

      wtProc.on('close', (code: number | null) => {
        if (!wtResponded) {
          wtResponded = true
          send(client.socket, { type: 'server-error', message: `wt-spawn exited (code ${code}) without output` })
        }
      })

      break
    }

    case 'validate-directory': {
      try {
        const dirPath = resolveFilePath(msg.path)
        const stat = fs.statSync(dirPath)
        if (stat.isDirectory()) {
          send(client.socket, { type: 'validate-directory-result', seq: msg.seq, valid: true })
        } else {
          send(client.socket, { type: 'validate-directory-result', seq: msg.seq, valid: false, error: 'Path is a file, not a directory' })
        }
      } catch {
        send(client.socket, { type: 'validate-directory-result', seq: msg.seq, valid: false, error: 'Path does not exist' })
      }
      break
    }

    case 'file-add': {
      try {
        let posX: number
        let posY: number
        if (msg.x != null && msg.y != null) {
          posX = msg.x
          posY = msg.y
        } else {
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: FILE_WIDTH, height: FILE_HEIGHT })
          posX = pos.x
          posY = pos.y
        }
        const fileNode = stateManager.createFile(msg.parentId, posX, posY, msg.filePath)
        send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: fileNode.id })
      } catch (err: any) {
        console.error(`file-add failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `file-add failed: ${err.message}` })
      }
      break
    }

    case 'file-path': {
      try {
        stateManager.updateFilePath(msg.nodeId, msg.filePath)
        // Update watchers for file-backed child markdowns
        const fpCwd = getAncestorCwd(stateManager.getState().nodes, msg.nodeId)
        const fpResolvedPath = resolveFilePath(msg.filePath, fpCwd)
        const allNodes = stateManager.getState().nodes
        for (const child of Object.values(allNodes)) {
          if (child.type === 'markdown' && child.fileBacked && child.parentId === msg.nodeId) {
            fileContentManager.updatePath(child.id, msg.nodeId, fpResolvedPath)
          }
        }
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      } catch (err: any) {
        console.error(`file-path failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `file-path failed: ${err.message}` })
      }
      break
    }

    case 'validate-file': {
      try {
        const filePath = resolveFilePath(msg.path, msg.cwd)
        const stat = fs.statSync(filePath)
        if (stat.isFile()) {
          send(client.socket, { type: 'validate-file-result', seq: msg.seq, valid: true })
        } else {
          send(client.socket, { type: 'validate-file-result', seq: msg.seq, valid: false, error: 'Path is a directory, not a file' })
        }
      } catch {
        send(client.socket, { type: 'validate-file-result', seq: msg.seq, valid: false, error: 'Path does not exist' })
      }
      break
    }

    case 'markdown-add': {
      let posX: number
      let posY: number
      if (msg.x != null && msg.y != null) {
        posX = msg.x
        posY = msg.y
      } else {
        const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: MARKDOWN_DEFAULT_WIDTH, height: MARKDOWN_DEFAULT_HEIGHT })
        posX = pos.x
        posY = pos.y
      }
      const mdParent = stateManager.getNode(msg.parentId)
      const mdFileBacked = mdParent?.type === 'file'
      const mdNode = stateManager.createMarkdown(msg.parentId, posX, posY, undefined, mdFileBacked || undefined)
      if (mdFileBacked && mdParent.type === 'file') {
        const mdCwd = getAncestorCwd(stateManager.getState().nodes, mdParent.id)
        const mdResolvedPath = resolveFilePath(mdParent.filePath, mdCwd)
        fileContentManager.startWatching(mdNode.id, mdParent.id, mdResolvedPath)
      }
      send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: mdNode.id })
      break
    }

    case 'markdown-resize': {
      stateManager.resizeMarkdown(msg.nodeId, msg.width, msg.height)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'markdown-content': {
      if (fileContentManager.isWatched(msg.nodeId)) {
        fileContentManager.writeContent(msg.nodeId, msg.content)
      } else {
        stateManager.updateMarkdownContent(msg.nodeId, msg.content)
      }
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'markdown-set-max-width': {
      stateManager.setMarkdownMaxWidth(msg.nodeId, msg.maxWidth)
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

    case 'title-add': {
      try {
        let posX: number
        let posY: number
        if (msg.x != null && msg.y != null) {
          posX = msg.x
          posY = msg.y
        } else {
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: TITLE_DEFAULT_WIDTH, height: TITLE_HEIGHT })
          posX = pos.x
          posY = pos.y
        }
        const titleNode = stateManager.createTitle(msg.parentId, posX, posY)
        send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: titleNode.id })
      } catch (err: any) {
        console.error(`title-add failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `title-add failed: ${err.message}` })
      }
      break
    }

    case 'title-text': {
      try {
        stateManager.updateTitleText(msg.nodeId, msg.text)
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      } catch (err: any) {
        console.error(`title-text failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `title-text failed: ${err.message}` })
      }
      break
    }

    case 'set-claude-status-unread': {
      claudeStateMachine.handleClientMarkUnread(msg.sessionId, msg.unread)
      break
    }

    case 'set-claude-status-asleep': {
      claudeStateMachine.handleClientMarkAsleep(msg.sessionId, msg.asleep)
      break
    }

    case 'fork-session': {
      try {
        const forkNode = stateManager.getNode(msg.nodeId)
        if (!forkNode || forkNode.type !== 'terminal') {
          send(client.socket, { type: 'server-error', message: `fork-session: node ${msg.nodeId} is not a terminal` })
          break
        }
        const forkDriver = agentDriver(forkNode.agentType)
        if (forkDriver.capabilities.forkStrategy === 'none') {
          send(client.socket, { type: 'server-error', message: `fork-session: ${forkDriver.label} does not support fork` })
          break
        }
        const history = forkNode.claudeSessionHistory ?? []
        if (history.length === 0) {
          send(client.socket, { type: 'server-error', message: `fork-session: no agent session history` })
          break
        }
        const forkCwd = forkNode.cwd ?? sessionManager.getCwd(forkNode.sessionId)
        if (!forkCwd) {
          send(client.socket, { type: 'server-error', message: `fork-session: cannot determine cwd` })
          break
        }

        const forkName = computeForkName(forkNode.name)
        const forkParentId = msg.nodeId

        if (forkDriver.capabilities.forkStrategy === 'native') {
          // The CLI forks its own session; the new id arrives via SessionStart.
          const sourceSessionId = lastAgentSessionId(history)
          if (!sourceSessionId) {
            send(client.socket, { type: 'server-error', message: `fork-session: no ${forkDriver.label} session id` })
            break
          }
          const forkOptions = forkDriver.buildCreateOptions({
            cwd: forkCwd,
            forkSessionId: sourceSessionId,
            extraArgs: parseExtraCliArgs(forkNode.extraCliArgs),
          })
          const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
          snapshotManager.addSession(forkPtyId, forkCols, forkRows)
          const forkPos = computePlacement(stateManager.getState().nodes, forkParentId, terminalPixelSize(forkCols, forkRows))
          stateManager.createTerminal({
            sessionId: forkPtyId, parentId: forkParentId, x: forkPos.x, y: forkPos.y,
            cols: forkCols, rows: forkRows, cwd: forkCwd, initialTitleHistory: forkNode.shellTitleHistory,
            name: forkName, insertAfterNodeId: msg.nodeId, agentType: 'codex'
          })
          if (forkNode.shellTitleHistory?.length) {
            sessionManager.seedTitleHistory(forkPtyId, forkNode.shellTitleHistory)
          }
          client.attachedSessions.add(forkPtyId)
          send(client.socket, { type: 'created', seq: msg.seq, sessionId: forkPtyId, cols: forkCols, rows: forkRows })
          console.log(`[fork-session] Forked Codex terminal ${msg.nodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (from ${sourceSessionId.slice(0, 8)})`)
          break
        }

        // Claude: clone JSONL then resume the new session id.
        let sourceClaudeSessionId: ClaudeSessionId | undefined
        for (let i = history.length - 1; i >= 0; i--) {
          if (fs.existsSync(sessionFilePath(forkCwd, history[i].claudeSessionId))) {
            sourceClaudeSessionId = history[i].claudeSessionId
            break
          }
        }
        if (!sourceClaudeSessionId) {
          send(client.socket, { type: 'server-error', message: `fork-session: no session transcript file found on disk` })
          break
        }

        const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId)
        const forkOptions = agentDrivers.claude.buildCreateOptions({ cwd: forkCwd, resumeSessionId: newClaudeSessionId, extraArgs: parseExtraCliArgs(forkNode.extraCliArgs) })
        const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
        snapshotManager.addSession(forkPtyId, forkCols, forkRows)

        const forkPos = computePlacement(stateManager.getState().nodes, forkParentId, terminalPixelSize(forkCols, forkRows))
        stateManager.createTerminal({
          sessionId: forkPtyId, parentId: forkParentId, x: forkPos.x, y: forkPos.y,
          cols: forkCols, rows: forkRows, cwd: forkCwd, initialTitleHistory: forkNode.shellTitleHistory,
          name: forkName, insertAfterNodeId: msg.nodeId
        })
        if (forkNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(forkPtyId, forkNode.shellTitleHistory)
        }

        client.attachedSessions.add(forkPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: forkPtyId, cols: forkCols, rows: forkRows })
        console.log(`[fork-session] Forked terminal ${msg.nodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (claude session ${newClaudeSessionId.slice(0, 8)})`)
      } catch (err: any) {
        console.error(`fork-session failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `fork-session failed: ${err.message}` })
      }
      break
    }

    case 'crab-reorder': {
      stateManager.reorderCrabs(msg.order)
      send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      break
    }

    case 'set-alerts-read-timestamp': {
      stateManager.setAlertsReadTimestamp(msg.nodeId, msg.timestamp)
      break
    }

    case 'terminal-restart': {
      try {
        const restartNode = stateManager.getNode(msg.nodeId)
        // Allow dead remnants too — Extra CLI restart is how users revive them.
        if (!restartNode || restartNode.type !== 'terminal') {
          send(client.socket, {
            type: 'server-error',
            seq: msg.seq,
            message: `terminal-restart: node ${msg.nodeId} is not a terminal`,
          })
          break
        }
        const restartCwd = restartNode.cwd ?? sessionManager.getCwd(restartNode.sessionId)
        const wasAlive = restartNode.alive

        // Capture previous extraCliArgs for recovery before updating
        const previousExtraCliArgs = restartNode.extraCliArgs ?? ''

        // Update extraCliArgs on the node
        stateManager.updateExtraCliArgs(msg.nodeId, msg.extraCliArgs)

        // Mark as restarting so terminalExited skips archival
        stateManager.markRestarting(msg.nodeId)

        // Capture resume target BEFORE destroying the PTY (in-memory last id dies with it).
        const oldSessionId = restartNode.sessionId
        const restartHistory = restartNode.claudeSessionHistory ?? []
        const liveAgentSessionId = sessionManager.getLastClaudeSessionId(oldSessionId)
        const extraArgs = parseExtraCliArgs(msg.extraCliArgs)
        let resumeId: string | undefined
        if (!agentDriver(restartNode.agentType).capabilities.claudeTranscript) {
          resumeId = resolveNonClaudeResumeId(restartNode, liveAgentSessionId)
          if (!resumeId) {
            serverLog(`[terminal-restart] WARNING: no ${restartNode.agentType} session id to resume for node ${msg.nodeId.slice(0, 8)}`)
          } else {
            serverLog(`[terminal-restart] ${restartNode.agentType} resume id=${resumeId.slice(0, 8)}`)
          }
        } else {
          resumeId = findValidClaudeSession(restartHistory, restartCwd)
        }

        // Destroy old PTY if it still exists (skip for already-dead remnants).
        if (wasAlive || sessionManager.has(oldSessionId)) {
          snapshotManager.removeSession(oldSessionId)
          sessionFileWatcher.unwatch(oldSessionId)
          codexSessionFileWatcher.unwatch(oldSessionId)
          cursorSessionFileWatcher.unwatch(oldSessionId)
          sessionManager.destroy(oldSessionId)
          clients.forEach((c) => {
            c.attachedSessions.delete(oldSessionId)
            c.snapshotSessions.delete(oldSessionId)
          })
        }

        const restartOptions: CreateOptions = {
          ...agentDriver(restartNode.agentType).buildCreateOptions({
            cwd: restartCwd,
            resumeSessionId: resumeId,
            extraArgs,
          }),
          nodeId: msg.nodeId,
        }
        const { sessionId: newPtyId, cols: restartCols, rows: restartRows } = respawnTerminal(
          msg.nodeId, () => sessionManager.create(restartOptions), RESPAWN_DEPS)
        // It launched, so whatever went wrong last time no longer applies.
        stateManager.setAlert(msg.nodeId, 'launch-failed', null)

        restartRecovery.record(msg.nodeId, {
          sessionId: newPtyId,
          previousExtraCliArgs,
          startedAt: Date.now(),
          isRetry: false
        })

        // Auto-attach client
        client.attachedSessions.add(newPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols: restartCols, rows: restartRows })
        serverLog(`[terminal-restart] Restarted terminal ${msg.nodeId.slice(0, 8)} with new session ${newPtyId.slice(0, 8)} resume=${resumeId ? resumeId.slice(0, 8) : '(none)'} extraCliArgs=${msg.extraCliArgs || '(none)'}`)
      } catch (err: any) {
        serverLog(`[terminal-restart] failed: ${err.message}${err.stack ? `\n${err.stack}` : ''}`)
        // The server-error toast is transient; the surface itself has to carry
        // the reason, or a terminal that failed to come back looks identical to
        // one the user deliberately left dead.
        stateManager.setAlert(msg.nodeId, 'launch-failed', `Restart failed: ${err.message}`)
        send(client.socket, {
          type: 'server-error',
          seq: msg.seq,
          message: `terminal-restart failed: ${err.message}`,
        })
      }
      break
    }

    case 'camera-bounds': {
      client.cameraBounds = msg.bounds
      const otherCount = clients.size - 1
      if (otherCount > 0) {
        serverLog(`[camera-bounds] client=${client.id.slice(0, 8)} broadcasting to ${otherCount} peers bounds=(${Math.round(msg.bounds.x)},${Math.round(msg.bounds.y)} ${Math.round(msg.bounds.width)}x${Math.round(msg.bounds.height)})`)
      }
      broadcastToOthers(client.socket, { type: 'peer-camera-bounds', clientId: client.id, bounds: msg.bounds })
      break
    }

    case 'save-viewport': {
      stateManager.setSavedViewport(msg.slot, msg.bounds)
      serverLog(`[save-viewport] slot=${msg.slot} bounds=(${Math.round(msg.bounds.x)},${Math.round(msg.bounds.y)} ${Math.round(msg.bounds.width)}x${Math.round(msg.bounds.height)}) -> broadcasting to ${clients.size} clients`)
      broadcastToAll({ type: 'saved-viewports', viewports: stateManager.getSavedViewports() })
      break
    }

    case 'focus-surface-request': {
      // Internal path (e.g. the spaceterm:// deep link): the sender already knows
      // a surface (pty session) id. Resolve it via the live pty-session map.
      const focusNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!focusNodeId) {
        // Use serverLog (not console.error) so this reaches electron.log — the
        // requester passed a surfaceId that no live pty session owns (a stale or
        // rotated id, or a node that was closed). Log the full id so it can be
        // cross-referenced with the sender's own log.
        serverLog(`[focus-surface] Unknown surfaceId: ${msg.surfaceId} (${clients.size} clients connected)`)
        break
      }
      raiseNodeOnClient(focusNodeId, `focus-surface surfaceId=${msg.surfaceId.slice(0, 8)}`)
      break
    }

    case 'focus-claude-session': {
      // External path (e.g. Voice Operator): the sender knows only a claude
      // session id. WE resolve it to a node against persisted state, so external
      // clients never touch spaceterm's surface/node ids.
      const focusNodeId = stateManager.getNodeIdForClaudeSession(msg.claudeSessionId)
      if (!focusNodeId) {
        serverLog(`[focus-claude-session] Unknown claudeSessionId: ${msg.claudeSessionId} (${clients.size} clients connected)`)
        break
      }
      raiseNodeOnClient(focusNodeId, `focus-claude-session claudeSessionId=${msg.claudeSessionId.slice(0, 8)}`)
      break
    }

    // A mod's own traffic, relayed by `modId` and never inspected. Goes to
    // the other clients (a mod's renderer half in another window) and to the
    // script connections that named this modId when they subscribed.
    case 'mod': {
      broadcastToOthers(client.socket, msg)
      scriptApi.broadcastMod(msg.modId, msg.event, msg.payload)
      break
    }

    default: {
      const unknownType = unhandledVariant(msg)
      console.error(`Unknown message type: ${unknownType}`)
      send(client.socket, { type: 'server-error', message: `Unknown message type: ${unknownType}` })
      break
    }
  }
}

/**
 * Probe a Unix socket file and remove it if stale. If the socket is alive and
 * `exitIfAlive` is set, another server is running — exit immediately.
 * For secondary sockets (hooks.sock) we just unlink stale files without the
 * alive-check exit since the bidirectional socket probe is the authority.
 */
async function cleanStaleSocket(socketPath: string, exitIfAlive: boolean): Promise<void> {
  if (!fs.existsSync(socketPath)) return
  const isAlive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath)
    const timer = setTimeout(() => { probe.destroy(); resolve(false) }, 1000)
    probe.on('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true) })
    probe.on('error', () => { clearTimeout(timer); resolve(false) })
  })
  if (isAlive && exitIfAlive) {
    console.error(`Another spaceterm server is already listening on ${socketPath}. Exiting.`)
    process.exit(1)
  }
  try { fs.unlinkSync(socketPath) } catch { /* stale file already gone */ }
}

/**
 * How long a freshly revived surface is immune to being archived by its own
 * exit. A pty that survives this long is stable; one that dies sooner should
 * stay visible as a dead remnant the user can retry, rather than being archived
 * out from under them.
 */
const REVIVAL_PROTECTION_MS = 30_000

/**
 * One-shot daemon requests, phrased as promises.
 *
 * Both temporarily displace `DaemonClient`'s message handler to intercept a
 * single reply, which is the same trick the inline startup code used — kept
 * because the daemon protocol has no request ids, so correlating a reply means
 * watching for the next one of its type.
 */
function listDaemonSessions(client: DaemonClient): Promise<DaemonSessionInfo[]> {
  return requestFromDaemon(client, { type: 'list' }, (msg) =>
    msg.type === 'listed' ? (msg.sessions as DaemonSessionInfo[]) : undefined
  )
}

function attachDaemonSession(client: DaemonClient, sessionId: PtySessionId): Promise<string> {
  return requestFromDaemon(client, { type: 'attach', id: sessionId }, (msg) =>
    msg.type === 'attached' && msg.id === sessionId ? String(msg.scrollback ?? '') : undefined
  )
}

/**
 * Send `request` and resolve with the first reply `match` accepts, passing
 * every other message through to the normal handler untouched.
 *
 * The handler is displaced *before* the request goes out, because the daemon
 * may answer synchronously and a reply that arrives before the interceptor is
 * installed would hang the promise forever.
 */
function requestFromDaemon<T>(
  client: DaemonClient,
  request: Record<string, unknown>,
  match: (msg: import('./daemon-client').DaemonMessage) => T | undefined
): Promise<T> {
  return new Promise<T>((resolve) => {
    const original = client['onMessage']
    client['onMessage'] = (msg) => {
      const hit = match(msg)
      if (hit !== undefined) {
        client['onMessage'] = original
        resolve(hit)
      } else {
        original(msg)
      }
    }
    client.send(request as never)
  })
}

async function startServer(): Promise<void> {
  // Write shell integration scripts (OSC 7 hooks for CWD reporting)
  setupShellIntegration()

  // Ensure socket directory exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true })
  fs.mkdirSync(HOOK_LOG_DIR, { recursive: true })

  // Report which optional integrations this machine has. Several features
  // degrade silently without them, and the log is where someone will look.
  for (const line of formatCapabilityReport(probeCapabilities())) serverLog(line)

  // Remove stale socket files — but first check if another server is alive.
  // If we blindly unlink, we'd steal the socket from a running server: the running
  // server's FD stays open (existing connections work) but new connections (hooks
  // from freshly spawned Claude terminals) can't reach it, silently breaking
  // Claude surface detection.
  await cleanStaleSocket(SOCKET_PATH, true)
  await cleanStaleSocket(HOOKS_SOCKET_PATH, false)
  await cleanStaleSocket(SCRIPTS_SOCKET_PATH, false)

  // Initialize StateManager — broadcasts node changes to all clients and script subscribers
  stateManager = new StateManager({
    onNodeUpdate: (nodeId, fields) => {
      broadcastToAll({ type: 'node-updated', nodeId, fields })
      scriptApi.broadcast('node-updated', nodeId, { type: 'node-updated', nodeId, fields })
    },
    onNodeAdd: (node) => {
      broadcastToAll({ type: 'node-added', node })
      scriptApi.broadcast('node-added', node.id, { type: 'node-added', node })
    },
    onNodeRemove: (nodeId) => {
      broadcastToAll({ type: 'node-removed', nodeId })
      scriptApi.broadcast('node-removed', nodeId, { type: 'node-removed', nodeId })
    }
  })

  // Initialize FileContentManager — manages bidirectional file sync for file-backed markdowns
  fileContentManager = new FileContentManager((nodeId, content) => {
    broadcastToAll({ type: 'file-content', nodeId, content })
  })

  // Initialize SnapshotManager — sends periodic snapshots to clients in snapshot mode
  snapshotManager = new SnapshotManager((snapshot) => {
    clients.forEach((client) => {
      if (client.snapshotSessions.has(snapshot.sessionId)) {
        send(client.socket, snapshot)
      }
    })
  })

  // Initialize DaemonClient — manages connection to the persistent PTY daemon
  daemonClient = new DaemonClient((msg) => {
    switch (msg.type) {
      case 'data':
        sessionManager.handleDaemonData(asPtySessionId(msg.id as string), msg.data as string)
        break
      case 'exit':
        sessionManager.handleDaemonExit(asPtySessionId(msg.id as string), msg.exitCode as number)
        break
      case 'error':
        console.error(`[pty-daemon] Error: ${msg.message}`)
        break
      // 'created' and 'attached' are handled by the startup reconciliation logic below,
      // or ignored during normal operation (create is fire-and-forget from the server's perspective).
    }
  })
  await daemonClient.connect()
  console.log('[startup] Connected to PTY daemon')

  sessionManager = new SessionManager(daemonClient, {
    // broadcast to attached clients + feed snapshot manager
    onData: (sessionId, data) => {
      snapshotManager.write(sessionId, data)
      broadcastToAttached(sessionId, { type: 'data', sessionId, data })
    },
    // broadcast to all attached clients + update state
    onExit: (sessionId, exitCode) => {
      // Log every PTY exit with its final output. A surface that "dies
      // immediately" (bad CLI flag, failed MCP, startup crash) leaves its
      // reason in the last lines of scrollback — captured here before the
      // session is torn down. Only the tail is logged to keep the file small.
      {
        const exitNodeId = stateManager.getNodeIdForSession(sessionId)
        const exitNode = exitNodeId ? stateManager.getNode(exitNodeId) : undefined
        const exitAgentType = exitNode?.type === 'terminal' ? exitNode.agentType ?? 'shell' : 'shell'
        const tail = (sessionManager.getScrollback(sessionId) || '').slice(-2000)
        serverLog(
          `[exit] ${sessionId.slice(0, 8)} agent=${exitAgentType} exitCode=${exitCode}` +
          (tail ? `\n[exit-output] ${sessionId.slice(0, 8)}:\n${sanitizeForLog(tail)}` : ' (no output)')
        )
      }

      // If this PTY was awaiting fork-settle, fail it immediately
      const pendingFork = pendingForkSettles.get(sessionId)
      if (pendingFork) {
        clearTimeout(pendingFork.timeoutId)
        pendingForkSettles.delete(sessionId)
        pendingFork.respond(`Session exited with code ${exitCode} before settling`)
      }

      sessionFileWatcher.unwatch(sessionId)
      codexSessionFileWatcher.unwatch(sessionId)
      cursorSessionFileWatcher.unwatch(sessionId)
      snapshotManager.removeSession(sessionId)

      // If this pty was spawned by a manual restart and died quickly, the new
      // CLI args are the likely cause: revert them and relaunch once.
      const nodeId = stateManager.getNodeIdForSession(sessionId)
      if (nodeId) {
        const recovery = restartRecovery.onExit(nodeId, sessionId, Date.now())
        if (recovery.kind === 'recover') {
          const elapsed = recovery.elapsedMs
          console.log(`[restart-recovery] PTY exited after ${elapsed}ms (exitCode=${exitCode}), recovering node ${nodeId.slice(0, 8)} with previous args`)

          // Prevent terminalExited from archiving
          stateManager.markRestarting(nodeId)
          stateManager.terminalExited(sessionId, exitCode)

          // Revert extraCliArgs and spawn new PTY
          stateManager.updateExtraCliArgs(nodeId, recovery.previousExtraCliArgs)
          const recoveryNode = stateManager.getNode(nodeId)
          if (recoveryNode && recoveryNode.type === 'terminal') {
            try {
              const recoveryCwd = recoveryNode.cwd
              const recoveryHistory = recoveryNode.claudeSessionHistory ?? []
              const recoveryArgs = parseExtraCliArgs(recovery.previousExtraCliArgs)
              const recoveryDriver = agentDriver(recoveryNode.agentType)
              const recoveryResumeId = recoveryDriver.capabilities.claudeTranscript
                ? findValidClaudeSession(recoveryHistory, recoveryCwd)
                : resolveNonClaudeResumeId(recoveryNode)
              const recoveryOptions: CreateOptions = {
                ...recoveryDriver.buildCreateOptions({
                  cwd: recoveryCwd,
                  resumeSessionId: recoveryResumeId,
                  extraArgs: recoveryArgs,
                }),
                nodeId,
              }
              const { sessionId: recoveryPtyId } = respawnTerminal(
                nodeId, () => sessionManager.create(recoveryOptions), RESPAWN_DEPS)

              restartRecovery.recordRetry(nodeId, recoveryPtyId, recovery.previousExtraCliArgs, Date.now())

              // Notify clients
              broadcastToAll({
                type: 'server-error',
                message: `Terminal restarted with new CLI args exited after ${(elapsed / 1000).toFixed(1)}s (exit code ${exitCode}). Reverted to previous args and restarted.`
              })
              console.log(`[restart-recovery] Recovered node ${nodeId.slice(0, 8)} → session ${recoveryPtyId.slice(0, 8)}`)
            } catch (err: any) {
              console.error(`[restart-recovery] Failed to recover node ${nodeId.slice(0, 8)}: ${err.message}`)
              restartRecovery.forget(nodeId)
            }
          } else {
            restartRecovery.forget(nodeId)
          }

          broadcastToAttached(sessionId, { type: 'exit', sessionId, exitCode })
          scriptApi.broadcast('exit', nodeId ?? undefined, { type: 'exit', nodeId, sessionId, exitCode })
          clients.forEach((client) => {
            client.attachedSessions.delete(sessionId)
            client.snapshotSessions.delete(sessionId)
          })
          return
        }
        if (recovery.kind === 'give-up') {
          console.log(`[restart-recovery] Not recovering node ${nodeId.slice(0, 8)}: ${recovery.reason} (${recovery.elapsedMs}ms)`)
        }
      }

      // Log diagnostic info when a startup-revived PTY fails
      if (nodeId && stateManager.isReviving(nodeId)) {
        const node = stateManager.getNode(nodeId)
        const claudeHistory = (node?.type === 'terminal' && node.claudeSessionHistory) || []
        const claudeSessionId = claudeHistory.length > 0 ? claudeHistory[claudeHistory.length - 1].claudeSessionId : 'unknown'
        const output = sessionManager.getScrollback(sessionId)
        console.error(`[startup] Revival failed for Claude session ${claudeSessionId} (pty=${sessionId.slice(0, 8)}, exitCode=${exitCode})`)
        if (output) {
          console.error(`[startup] Revival output:\n${sanitizeForLog(output)}`)
        } else {
          console.error(`[startup] Revival output: (none)`)
        }
      }

      stateManager.terminalExited(sessionId, exitCode)
      broadcastToAttached(sessionId, { type: 'exit', sessionId, exitCode })
      scriptApi.broadcast('exit', nodeId ?? undefined, { type: 'exit', nodeId, sessionId, exitCode })
      // Remove from all clients' attached/snapshot sets
      clients.forEach((client) => {
        client.attachedSessions.delete(sessionId)
        client.snapshotSessions.delete(sessionId)
      })
    },
    // update state (node-updated broadcast handles client sync)
    onTitleHistory: (sessionId, history) => {
      stateManager.updateShellTitleHistory(sessionId, history)
    },
    // update state (node-updated broadcast handles client sync)
    onCwd: (sessionId, cwd) => {
      stateManager.updateCwd(sessionId, cwd)
    },
    // update state (node-updated broadcast handles client sync)
    onClaudeSessionHistory: (sessionId, history) => {
      stateManager.updateClaudeSessionHistory(sessionId, history)
    },
    // track last interaction timestamp for footer display
    onActivity: (sessionId) => {
      stateManager.updateLastInteracted(sessionId, Date.now())
    }
  })

  // Initialize PlanCacheManager — caches plan file revisions for diffing
  planCacheManager = new PlanCacheManager()

  // Initialize SessionTitleSummarizer — generates 3-word titles from session transcripts
  sessionTitleSummarizer = new SessionTitleSummarizer({
    injectTitle: (sessionId, title) => sessionManager.injectTitle(sessionId, title),
  })

  // Initialize PotentialErrorDetector — identifies stopped API errors without writing to the PTY.
  potentialErrorDetector = new PotentialErrorDetector({
    getScrollback: (id) => sessionManager.getScrollback(id),
    getNodeTitle: (id) => {
      const nodeId = stateManager.getNodeIdForSession(id)
      if (!nodeId) return null
      const node = stateManager.getNode(nodeId)
      if (!node || node.type !== 'terminal') return null
      // Prefer user-set name, fall back to first shell title
      return node.name || node.shellTitleHistory?.[0] || null
    },
  })

  // Initialize ClaudeStateMachine — manages state indicator transitions, queue, stale sweep
  claudeStateMachine = new ClaudeStateMachine({
    getClaudeState: (id) => stateManager.getClaudeState(id),
    setClaudeState: (id, state) => stateManager.updateClaudeState(id, state),
    hasPotentialError: (id) => potentialErrorDetector.hasPotentialError(id),
    getClaudeStatusUnread: (id) => stateManager.getClaudeStatusUnread(id),
    setClaudeStatusUnread: (id, unread) => stateManager.updateClaudeStatusUnread(id, unread),
    setClaudeStatusAsleep: (id, asleep) => stateManager.updateClaudeStatusAsleep(id, asleep),
    handleClaudeStop: (id) => sessionManager.handleClaudeStop(id),
    broadcastClaudeStateDecisionTime: (id, ts) => stateManager.updateClaudeStateDecisionTime(id, ts),
  })

  // Initialize SessionFileWatcher — watches Claude session JSONL files for line count + plan cache + state routing
  sessionFileWatcher = new SessionFileWatcher((surfaceId, newEntries, totalLineCount, isBackfill) => {
    publishSessionLineCount(surfaceId, totalLineCount)

    // Plan-cache tracking: scan assistant entries for plan file writes and ExitPlanMode.
    // This runs for both backfill and live entries (plan file paths need to be ready
    // for future snapshots), but ExitPlanMode snapshotting only runs live.
    for (const entry of newEntries) {
      if (entry.type !== 'assistant') continue
      const assistantContent = (entry.message as any)?.content
      if (!Array.isArray(assistantContent)) continue
      for (const block of assistantContent) {
        if (block.type !== 'tool_use') continue
        if ((block.name === 'Write' || block.name === 'Edit') &&
            typeof block.input?.file_path === 'string' &&
            block.input.file_path.includes('/.claude/plans/')) {
          planCacheManager.trackPlanFile(surfaceId, block.input.file_path)
        }
        // Only snapshot on live ExitPlanMode — during backfill the file on disk
        // only has its latest content, so snapshots would be misleading.
        if (!isBackfill && block.name === 'ExitPlanMode') {
          const claudeSessionId = sessionManager.getLastClaudeSessionId(surfaceId)
          if (claudeSessionId) {
            const files = planCacheManager.snapshot(surfaceId, claudeSessionId)
            if (files.length >= 2) {
              broadcastToAttached(surfaceId, {
                type: 'plan-cache-update',
                sessionId: surfaceId,
                count: files.length,
                files
              })
            }
          }
        }
      }
    }

    // Delegate state routing to the state machine
    claudeStateMachine.handleJsonlEntries(surfaceId, newEntries, isBackfill)
  })

  // Codex's hooks expose lifecycle ids, while its rollout JSONL exposes the
  // context-window telemetry. Keep this independent of Claude-only parsing.
  codexSessionFileWatcher = new CodexSessionFileWatcher((surfaceId, newEntries) => {
    for (const entry of newEntries) {
      if (entry.type !== 'event_msg') continue
      const payload = entry.payload as Record<string, unknown> | undefined
      if (payload?.type !== 'token_count') continue
      const info = payload.info as Record<string, unknown> | undefined
      const usage = info?.last_token_usage as Record<string, unknown> | undefined
      const usedTokens = usage?.total_tokens
      const windowTokens = info?.model_context_window
      if (typeof usedTokens !== 'number' || !Number.isFinite(usedTokens) || usedTokens < 0 ||
          typeof windowTokens !== 'number' || !Number.isFinite(windowTokens) || windowTokens <= 0) continue
      const remainingPercent = Math.max(0, Math.min(100, (1 - usedTokens / windowTokens) * 100))
      publishContextPercent(surfaceId, remainingPercent)
    }
  })

  cursorSessionFileWatcher = new CursorSessionFileWatcher((surfaceId, newEntries) => {
    claudeStateMachine.handleCursorTranscriptEntries(surfaceId, newEntries)
  })

  summaryChat = new SummaryChat(
    (nodeId, speaking, voice) => {
      broadcastToAll({ type: 'speaking-changed', nodeId, speaking, voice })
    },
    (nodeId, state, message) => {
      broadcastToAll({ type: 'summary-chat-status', nodeId, state, message })
    },
  )

  // --- Startup: reconcile with daemon sessions, then revive remaining terminals ---
  //
  // The sequence lives in startup-recovery.ts so it can be driven against a
  // fake daemon; this is only the wiring. Everything below is a one-line
  // adapter from a singleton to the narrow operation recovery asked for.
  const recoveryOutcome = await recoverSurfaces({
    listDaemonSessions: () => listDaemonSessions(daemonClient),
    attachDaemonSession: (sessionId) => attachDaemonSession(daemonClient, sessionId),
    destroyDaemonSession: (sessionId) => daemonClient.send({ type: 'destroy', id: sessionId }),

    takeRecoverableTerminals: () => stateManager.processDeadTerminals(),
    getNode: (nodeId) => stateManager.getNode(nodeId),
    archiveTerminal: (nodeId) => stateManager.archiveTerminal(nodeId),
    markReviving: (nodeId) => stateManager.markReviving(nodeId),
    clearReviving: (nodeId) => stateManager.clearReviving(nodeId),

    resolveResumeTarget(node, recorded) {
      if (node.type !== 'terminal') return undefined
      return agentDriver(node.agentType).capabilities.claudeTranscript
        // Claude verifies against the transcript on disk: a recorded id whose
        // JSONL never got written is a ghost that fails every restart.
        ? (recorded ? findValidClaudeSession(node.claudeSessionHistory ?? [], node.cwd) : undefined)
        : resolveNonClaudeResumeId(node) ?? recorded
    },
    requiresResumableSession: (node) =>
      agentDriver(node?.type === 'terminal' ? node.agentType : undefined)
        .capabilities.requiresResumableSession,

    reattachSurface(nodeId, pty, scrollback, cwd) {
      respawnTerminal(nodeId, () => {
        // The pty already exists in the daemon; adopt it rather than spawn one.
        sessionManager.reattachSession(pty.sessionId, scrollback, pty.cols, pty.rows, cwd)
        return pty
      }, RESPAWN_DEPS)
      // Feed scrollback into the snapshot manager so a client attaching
      // immediately sees the same screen the daemon has.
      if (scrollback) snapshotManager.write(pty.sessionId, scrollback)
    },

    reviveSurface(terminal, resumeSessionId) {
      const node = stateManager.getNode(terminal.nodeId)
      const driver = agentDriver(node?.type === 'terminal' ? node.agentType : undefined)
      const options = {
        ...driver.buildCreateOptions({
          cwd: terminal.cwd,
          resumeSessionId,
          extraArgs: parseExtraCliArgs(terminal.extraCliArgs),
        }),
        nodeId: terminal.nodeId,
      }
      return respawnTerminal(terminal.nodeId, () => sessionManager.create(options), RESPAWN_DEPS).sessionId
    },

    watchTranscript(sessionId, nodeId, resumeSessionId) {
      const node = stateManager.getNode(nodeId)
      const agentType = node?.type === 'terminal' ? node.agentType : undefined
      watchAgentTranscript(sessionId, agentType, resumeSessionId, sessionManager.getCwd(sessionId))
    },

    log: (line) => console.log(line),
  })

  // Revival protection stays armed for 30s: a pty that survives that long is
  // stable, and one that dies sooner should stay visible as a dead remnant the
  // user can retry rather than being archived out from under them.
  if (recoveryOutcome.revived.length > 0) {
    setTimeout(() => {
      for (const nodeId of recoveryOutcome.revived) stateManager.clearReviving(nodeId)
      console.log(`[startup] Cleared revival protection for ${recoveryOutcome.revived.length} terminal(s)`)
    }, REVIVAL_PROTECTION_MS)
  }

  // --- Git status polling for directory nodes ---
  gitStatusPoller = new GitStatusPoller(
    () => stateManager.getDirectoryNodes(),
    (nodeId, gitStatus) => stateManager.updateDirectoryGitStatus(nodeId, gitStatus)
  )

  // --- GitHub GraphQL rate limit polling ---
  ghRateLimitPoller = new GhRateLimitPoller((report) => {
    broadcastToAll({ type: 'gh-rate-limit', ...report })
  })
  void ghRateLimitPoller.start()

  // --- Startup revival: start watchers for file-backed markdowns ---
  const allStartupNodes = stateManager.getState().nodes
  for (const node of Object.values(allStartupNodes)) {
    if (node.type === 'markdown' && node.fileBacked) {
      const parent = allStartupNodes[node.parentId]
      if (parent?.type === 'file') {
        const fbCwd = getAncestorCwd(allStartupNodes, parent.id)
        const fbPath = resolveFilePath(parent.filePath, fbCwd)
        fileContentManager.startWatching(node.id, parent.id, fbPath)
        console.log(`[startup] Watching file-backed markdown ${node.id.slice(0, 8)} → ${fbPath}`)
      }
    }
  }

  // --- Bidirectional socket (Electron client ↔ server) ---
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')

    const client: ClientConnection = {
      id: randomUUID(),
      socket,
      attachedSessions: new Set(),
      snapshotSessions: new Set(),
      attachBuffers: new Map(),
      parser: new LineParser((msg) => {
        handleMessage(client, msg as ClientMessage)
      }),
      cameraBounds: null
    }

    clients.add(client)
    console.log(`Client connected id=${client.id.slice(0, 8)} (${clients.size} total)`)

    // Send existing peers' camera bounds to the new client
    clients.forEach((existing) => {
      if (existing !== client && existing.cameraBounds) {
        send(socket, { type: 'peer-camera-bounds', clientId: existing.id, bounds: existing.cameraBounds })
      }
    })
    // Notify other clients about the new peer
    broadcastToOthers(socket, { type: 'peer-connected', clientId: client.id })

    // Send the shared saved viewport slots to the new client
    send(socket, { type: 'saved-viewports', viewports: stateManager.getSavedViewports() })

    const summaryTargetNodeId = summaryChat.getTargetNodeId()
    if (summaryTargetNodeId) {
      send(socket, { type: 'summary-chat-status', nodeId: summaryTargetNodeId, state: 'target' })
    }

    // Send the latest GitHub rate-limit reading immediately so the client
    // doesn't wait a full poll interval for a sparkline.
    const ghReport = ghRateLimitPoller?.current()
    if (ghReport) {
      send(socket, { type: 'gh-rate-limit', ...ghReport })
    }

    socket.on('data', (data) => {
      client.parser.feed(data)
    })

    socket.on('close', () => {
      clients.delete(client)
      console.log(`Client disconnected id=${client.id.slice(0, 8)} (${clients.size} total)`)
      broadcastToAll({ type: 'peer-disconnected', clientId: client.id })
    })

    socket.on('error', (err) => {
      console.error('Client socket error:', err.message)
      clients.delete(client)
      broadcastToAll({ type: 'peer-disconnected', clientId: client.id })
    })
  })

  server.listen(SOCKET_PATH, () => {
    console.log(`Bidirectional server listening on ${SOCKET_PATH}`)
  })

  server.on('error', (err) => {
    console.error('Server error:', err)
    process.exit(1)
  })

  // --- Hooks socket (fire-and-forget ingest from hooks, status-line, MCP tools) ---
  const hooksServer = net.createServer((socket) => {
    socket.setEncoding('utf8')

    const parser = new LineParser((msg) => {
      handleIngestMessage(msg as IngestMessage)
    })

    socket.on('data', (data) => parser.feed(data))
    socket.on('error', (err) => {
      console.error('Hooks socket error:', err.message)
    })
  })

  hooksServer.listen(HOOKS_SOCKET_PATH, () => {
    console.log(`Hooks server listening on ${HOOKS_SOCKET_PATH}`)
  })

  hooksServer.on('error', (err) => {
    console.error('Hooks server error:', err)
    process.exit(1)
  })

  // --- Scripts socket (request/response + subscriptions for scripts inside PTYs) ---
  const scriptsServer = net.createServer((socket) => {
    socket.setEncoding('utf8')

    const connection = scriptConnectionFor(socket)
    const parser = new LineParser((msg) => {
      scriptApi.handle(connection, msg as ScriptMessage)
    })

    socket.on('data', (data) => parser.feed(data))
    socket.on('error', (err) => {
      console.error('Scripts socket error:', err.message)
    })
  })

  scriptsServer.listen(SCRIPTS_SOCKET_PATH, () => {
    console.log(`Scripts server listening on ${SCRIPTS_SOCKET_PATH}`)
  })

  scriptsServer.on('error', (err) => {
    console.error('Scripts server error:', err)
    process.exit(1)
  })

  // Graceful shutdown
  let socketWatchdog: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('\nShutting down...')
    if (socketWatchdog) clearInterval(socketWatchdog)
    // Flush queued transitions and stop timers before persisting state
    claudeStateMachine.dispose()
    gitStatusPoller.dispose()
    fileContentManager.dispose()
    sessionFileWatcher.dispose()
    codexSessionFileWatcher.dispose()
    cursorSessionFileWatcher.dispose()
    summaryChat.dispose()
    snapshotManager.dispose()
    stateManager.persistImmediate()
    sessionManager.destroyAll() // Cleans local state only — daemon PTYs persist
    daemonClient.dispose()
    server.close()
    hooksServer.close()
    scriptsServer.close()
    try { fs.unlinkSync(SOCKET_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(HOOKS_SOCKET_PATH) } catch { /* ignore */ }
    try { fs.unlinkSync(SCRIPTS_SOCKET_PATH) } catch { /* ignore */ }
    process.exit(exitCode)
  }
  shutdownServer = shutdown

  // Node passes the signal name to listeners; keep it out of shutdown's
  // numeric exit-code parameter so Ctrl+C exits cleanly with code 0.
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())

  // Socket watchdog — detect if our socket files disappear (e.g. another server
  // stole them, accidental rm). Without the files on disk, hook-handler.sh can't
  // deliver hooks via `nc -U`, silently breaking Claude surface detection.
  // Die immediately so the user (or a process manager) can restart cleanly.
  const SOCKET_WATCHDOG_INTERVAL_MS = 5_000
  socketWatchdog = setInterval(() => {
    if (!fs.existsSync(SOCKET_PATH) || !fs.existsSync(HOOKS_SOCKET_PATH) || !fs.existsSync(SCRIPTS_SOCKET_PATH)) {
      console.error('Socket file disappeared — another server may have taken over. Shutting down.')
      shutdown()
    }
  }, SOCKET_WATCHDOG_INTERVAL_MS)
}

startServer()
