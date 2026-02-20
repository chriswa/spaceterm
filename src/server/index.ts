import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { SOCKET_DIR, SOCKET_PATH, HOOK_LOG_DIR, DECISION_LOG_DIR } from '../shared/protocol'
import type { ClientMessage, ServerMessage, CreateOptions } from '../shared/protocol'
import { SessionManager } from './session-manager'
import { StateManager } from './state-manager'
import { SnapshotManager } from './snapshot-manager'
import { canFitAt, computePlacement } from './node-placement'
import { nodePixelSize, terminalPixelSize, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, DIRECTORY_WIDTH, DIRECTORY_HEIGHT, FILE_WIDTH, FILE_HEIGHT, TITLE_DEFAULT_WIDTH, TITLE_HEIGHT, IMAGE_DEFAULT_WIDTH, IMAGE_DEFAULT_HEIGHT } from '../shared/node-size'
import { setupShellIntegration } from './shell-integration'
import { LineParser } from './line-parser'
import { SessionFileWatcher } from './session-file-watcher'
import { DecisionLogger } from './decision-logger'
import { FileContentManager } from './file-content-manager'
import { GitStatusPoller } from './git-status-poller'
import { PlanCacheManager } from './plan-cache'
import { resolveFilePath, getAncestorCwd } from './path-utils'
import { forkSession } from './session-fork'
import { parse as shellParse } from 'shell-quote'

/**
 * Claude Code reserves this many tokens as a buffer before triggering autocompact.
 * The effective context window = context_window_size - this buffer.
 * UPDATE THIS when Claude Code changes its compaction threshold.
 */
const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 33_000

/** Spaceterm project root (two levels up from src/server/). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

const GENERATED_IMAGES_DIR = path.join(SOCKET_DIR, 'generated-images') + path.sep

/** Delete the backing file for an image node if it lives inside generated-images/. */
function deleteGeneratedImageFile(node: import('../shared/state').NodeData | undefined): void {
  if (!node || node.type !== 'image') return
  const resolved = path.resolve(node.filePath)
  if (resolved.startsWith(GENERATED_IMAGES_DIR)) {
    fs.unlink(resolved, () => {})
  }
}

/**
 * Build CreateOptions for spawning a Claude Code PTY with full plugin/settings args.
 * Paths are absolute so they work regardless of the spawned process's cwd.
 */
/**
 * Walk the ancestor chain from `startNodeId` upward, collecting context from
 * markdown nodes (non-file-backed content) and file nodes (resolved paths).
 * Returns the accumulated pieces joined with newlines, or undefined if none found.
 */
function gatherAncestorPrompt(nodes: Record<string, import('../shared/state').NodeData>, startNodeId: string): string | undefined {
  const parts: string[] = []
  let currentId = startNodeId
  const visited = new Set<string>()
  while (currentId && currentId !== 'root') {
    if (visited.has(currentId)) break
    visited.add(currentId)
    const node = nodes[currentId]
    if (!node) break
    if (node.type === 'markdown' && !node.fileBacked && node.content.trim()) {
      parts.push(node.content)
    }
    if (node.type === 'file' && node.filePath) {
      const cwd = getAncestorCwd(nodes, node.parentId)
      parts.push(resolveFilePath(node.filePath, cwd))
    }
    currentId = node.parentId
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

/** Escape a string for embedding inside a shell single-quoted string. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function buildClaudeCodeCreateOptions(cwd?: string, resumeSessionId?: string, prompt?: string, appendSystemPrompt?: boolean, extraArgs?: string[]): CreateOptions {
  const pluginDir = path.join(PROJECT_ROOT, 'src/claude-code-plugin')
  const statusLineSettings = JSON.stringify({
    statusLine: {
      type: 'command',
      command: path.join(pluginDir, 'scripts/statusline-handler.sh')
    }
  })
  const args = ['--plugin-dir', pluginDir, '--settings', statusLineSettings, '--allow-dangerously-skip-permissions']
  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs)
  }
  if (resumeSessionId) {
    args.push('-r', resumeSessionId)
  }
  if (prompt && appendSystemPrompt) {
    args.push('--append-system-prompt', prompt)

    // Print a banner showing the appended system prompt, then exec claude.
    // We use stty -echo before the printf to suppress PTY line discipline echo,
    // which otherwise causes the banner to appear twice — a known node-pty issue:
    //   https://github.com/microsoft/node-pty/issues/269 (duplicate writes on initial write)
    //   https://github.com/microsoft/node-pty/issues/78  (PTY echo duplication)
    //   https://github.com/microsoft/node-pty/issues/354 (duplicated output)
    const header = ' The following was appended to the system prompt '
    const footer = ' The preceding was appended to the system prompt '
    // Normalize newlines to \r\n for terminal display (CRLF)
    const termPrompt = prompt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')
    const claudeCmd = ['claude', ...args].map(a => shellQuote(a)).join(' ')
    const script = [
      'stty -echo',
      `printf '\\x1b[30;47m${header}\\x1b[0m\\r\\n'`,
      `printf '%s\\r\\n' ${shellQuote(termPrompt)}`,
      `printf '\\x1b[30;47m${footer}\\x1b[0m\\r\\n\\r\\n'`,
      'stty echo',
      `exec ${claudeCmd}`
    ].join('; ')
    return { cwd, command: '/bin/sh', args: ['-c', script] }
  } else if (prompt) {
    args.push('--', prompt)
  }
  return { cwd, command: 'claude', args }
}

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
let sessionFileWatcher: SessionFileWatcher
let fileContentManager: FileContentManager
let gitStatusPoller: GitStatusPoller
let planCacheManager: PlanCacheManager
let decisionLogger: DecisionLogger

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

/**
 * State transition queue — events from hooks and JSONL are held for 500ms then
 * processed in source-timestamp order.  This prevents race conditions where a
 * late-arriving event from one source clobbers an authoritative state set by
 * the other (e.g. a JSONL assistant message overriding a Stop hook).
 */
const TRANSITION_DELAY_MS = 500
const TRANSITION_DRAIN_INTERVAL_MS = 50

/** How long a surface can stay in 'working' with no events before it's considered stuck */
const STALE_WORKING_TIMEOUT_MS = 2 * 60 * 1000
/** How often to check for stale working surfaces */
const STALE_SWEEP_INTERVAL_MS = 15_000
/** Last event timestamp per surface — updated by applyTransition and queueTransition */
const lastActivityBySurface = new Map<string, number>()
let staleSweepTimer: ReturnType<typeof setInterval> | null = null

interface QueuedTransition {
  sourceTime: number  // epoch ms — when the event actually happened
  surfaceId: string
  newState: import('../shared/state').ClaudeState
  source: 'hook' | 'jsonl'
  event: string
  detail?: string
}

const transitionQueue: QueuedTransition[] = []
let transitionDrainTimer: ReturnType<typeof setInterval> | null = null

// Permission tool_use_id tracking — correlates PreToolUse → PermissionRequest → PostToolUse
// so that only the PostToolUse matching a permission-gated tool triggers a working transition,
// ignoring subagent PostToolUse events that would incorrectly clear waiting_permission.
const lastPreToolUseId = new Map<string, string>()         // surfaceId → tool_use_id
const pendingPermissionIds = new Map<string, Set<string>>() // surfaceId → Set<tool_use_id>

function queueTransition(
  surfaceId: string,
  newState: import('../shared/state').ClaudeState,
  source: 'hook' | 'jsonl',
  event: string,
  sourceTime: number,
  detail?: string
): void {
  transitionQueue.push({ sourceTime, surfaceId, newState, source, event, detail })
}

function drainTransitionQueue(flush = false): void {
  const cutoff = flush ? Infinity : Date.now() - TRANSITION_DELAY_MS
  const ready: QueuedTransition[] = []
  const remaining: QueuedTransition[] = []
  for (const t of transitionQueue) {
    if (t.sourceTime <= cutoff) {
      ready.push(t)
    } else {
      remaining.push(t)
    }
  }
  if (ready.length === 0) return
  transitionQueue.length = 0
  transitionQueue.push(...remaining)

  // Process in source-timestamp order so causally-later events win
  ready.sort((a, b) => a.sourceTime - b.sourceTime)
  for (const t of ready) {
    applyTransition(t.surfaceId, t.newState, t.source, t.event, t.detail)
  }
}

function applyTransition(
  surfaceId: string,
  newState: import('../shared/state').ClaudeState,
  source: 'hook' | 'jsonl',
  event: string,
  detail?: string
): void {
  lastActivityBySurface.set(surfaceId, Date.now())
  const prevState = sessionManager.getClaudeState(surfaceId) ?? 'stopped'

  // Don't downgrade waiting_plan to waiting_permission — the PermissionRequest
  // hook already set the more specific state and Notification shouldn't override it.
  if (prevState === 'waiting_plan' && newState === 'waiting_permission') {
    stateManager.updateClaudeStateDecisionTime(surfaceId, Date.now())
    decisionLogger.log(surfaceId, {
      timestamp: localISOTimestamp(),
      source,
      event,
      prevState,
      newState: prevState,
      detail,
      suppressed: true
    })
    return
  }

  sessionManager.setClaudeState(surfaceId, newState)

  // Compute unread: flip to true when entering an attention-needed state
  let unread: boolean | undefined
  if (prevState !== newState) {
    if (newState === 'stopped' || newState === 'waiting_permission' || newState === 'waiting_plan') {
      unread = true
      sessionManager.setClaudeStatusUnread(surfaceId, true)
    }
  }

  stateManager.updateClaudeStateDecisionTime(surfaceId, Date.now())

  decisionLogger.log(surfaceId, {
    timestamp: localISOTimestamp(),
    source,
    event,
    prevState,
    newState,
    detail,
    unread
  })
}

function sweepStaleSurfaces(): void {
  const now = Date.now()
  for (const [surfaceId, lastActivity] of lastActivityBySurface) {
    if (now - lastActivity > STALE_WORKING_TIMEOUT_MS && sessionManager.getClaudeState(surfaceId) === 'working') {
      sessionManager.setClaudeState(surfaceId, 'stuck')
      stateManager.updateClaudeStateDecisionTime(surfaceId, now)
      sessionManager.setClaudeStatusUnread(surfaceId, true)
      decisionLogger.log(surfaceId, {
        timestamp: localISOTimestamp(),
        source: 'stale',
        event: 'stale:timeout',
        prevState: 'working',
        newState: 'stuck',
        unread: true
      })
    }
  }
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
          claudeState: sessionManager.getClaudeState(msg.sessionId),
          claudeStatusUnread: sessionManager.getClaudeStatusUnread(msg.sessionId),
          claudeContextPercent: sessionManager.getClaudeContextPercent(msg.sessionId) ?? undefined,
          claudeSessionLineCount: sessionManager.getClaudeSessionLineCount(msg.sessionId) ?? undefined
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
      // Send cached plan files if available — the plan-cache-update event
      // may have been broadcast during backfill before this client attached.
      const claudeSessionId = sessionManager.getLastClaudeSessionId(msg.sessionId)
      if (claudeSessionId) {
        const planFiles = planCacheManager.getVersions(claudeSessionId)
        if (planFiles.length >= 2) {
          send(client.socket, {
            type: 'plan-cache-update',
            sessionId: msg.sessionId,
            count: planFiles.length,
            files: planFiles
          })
        }
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

      const isPromptSubmit = msg.data === '\r'
      const wasUnread = sessionManager.getClaudeStatusUnread(msg.sessionId)
      const prevState = sessionManager.getClaudeState(msg.sessionId) ?? 'stopped'

      // Fast path: nothing to change
      if (!wasUnread && (!isPromptSubmit || prevState === 'stopped' || prevState === 'stuck')) break

      if (wasUnread) {
        sessionManager.setClaudeStatusUnread(msg.sessionId, false)
      }

      let newState = prevState
      if (isPromptSubmit && prevState !== 'stopped' && prevState !== 'stuck') {
        // Enter from waiting_plan/waiting_permission: user is responding, Claude will process it.
        // Enter from working: stray keypress, Claude ignores it (Escape is the interrupt key).
        // In all cases, Claude is or will be working. The Stop hook handles actual stops.
        newState = 'working'
        sessionManager.setClaudeState(msg.sessionId, 'working')
        stateManager.updateClaudeStateDecisionTime(msg.sessionId, Date.now())
      }

      decisionLogger.log(msg.sessionId, {
        timestamp: localISOTimestamp(),
        source: 'client',
        event: isPromptSubmit ? 'client:promptSubmit' : 'client:interact',
        prevState,
        newState,
        unread: false
      })
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
        if (err) {
          console.error(`Failed to write hook log: ${err.message}`)
          send(client.socket, { type: 'server-error', message: `Failed to write hook log: ${err.message}` })
        }
      })

      // Track Stop hooks so we can distinguish real forks from claude -r startups
      const hookTime = typeof msg.ts === 'number' ? msg.ts : Date.now()
      if (hookType === 'Stop') {
        sessionManager.handleClaudeStop(msg.surfaceId)
        queueTransition(msg.surfaceId, 'stopped', 'hook', 'hook:Stop', hookTime)
        pendingPermissionIds.delete(msg.surfaceId)
        lastPreToolUseId.delete(msg.surfaceId)
        lastActivityBySurface.delete(msg.surfaceId)
      }

      // PermissionRequest: check tool_name to distinguish plan approval from other permissions
      if (hookType === 'PermissionRequest') {
        // Capture tool_use_id from the preceding PreToolUse so we can match
        // the eventual PostToolUse to this specific permission-gated tool.
        const savedToolUseId = lastPreToolUseId.get(msg.surfaceId)
        if (savedToolUseId) {
          let ids = pendingPermissionIds.get(msg.surfaceId)
          if (!ids) { ids = new Set(); pendingPermissionIds.set(msg.surfaceId, ids) }
          ids.add(savedToolUseId)
        }
        const toolName = msg.payload && typeof msg.payload === 'object' && 'tool_name' in msg.payload
          ? String(msg.payload.tool_name)
          : ''
        queueTransition(
          msg.surfaceId,
          toolName === 'ExitPlanMode' ? 'waiting_plan' : 'waiting_permission',
          'hook',
          'hook:PermissionRequest',
          hookTime,
          toolName
        )
      }

      // Notification hooks: permission_prompt and elicitation_dialog mean user needs to act
      // (waiting_plan guard is in applyTransition so it works correctly with the queue)
      if (hookType === 'Notification' && msg.payload && typeof msg.payload === 'object') {
        const notificationType = 'notification_type' in msg.payload ? String(msg.payload.notification_type) : ''
        if (notificationType === 'permission_prompt' || notificationType === 'elicitation_dialog') {
          queueTransition(msg.surfaceId, 'waiting_permission', 'hook', 'hook:Notification', hookTime, notificationType)
        }
      }

      // Claude is actively working
      if (hookType === 'UserPromptSubmit' || hookType === 'PreToolUse' || hookType === 'SubagentStart' || hookType === 'PreCompact') {
        if (hookType === 'PreToolUse') {
          const toolUseId = msg.payload?.tool_use_id
          if (typeof toolUseId === 'string') {
            lastPreToolUseId.set(msg.surfaceId, toolUseId)
          }
        }
        if (hookType === 'UserPromptSubmit') {
          pendingPermissionIds.delete(msg.surfaceId)
          lastPreToolUseId.delete(msg.surfaceId)
        }
        queueTransition(msg.surfaceId, 'working', 'hook', `hook:${hookType}`, hookTime)
      }

      // PostToolUse: only transition to working if this matches a permission-gated tool.
      // Subagent PostToolUse events (with different tool_use_ids) are correctly ignored,
      // preventing them from clearing waiting_permission on the main agent's surface.
      if (hookType === 'PostToolUse' || hookType === 'PostToolUseFailure') {
        const toolUseId = msg.payload?.tool_use_id
        const ids = pendingPermissionIds.get(msg.surfaceId)
        if (typeof toolUseId === 'string' && ids?.delete(toolUseId)) {
          queueTransition(msg.surfaceId, 'working', 'hook', `hook:${hookType}`, hookTime)
        }
      }

      // SessionEnd: session is done
      if (hookType === 'SessionEnd') {
        queueTransition(msg.surfaceId, 'stopped', 'hook', 'hook:SessionEnd', hookTime)
        pendingPermissionIds.delete(msg.surfaceId)
        lastPreToolUseId.delete(msg.surfaceId)
        lastActivityBySurface.delete(msg.surfaceId)
      }

      // Process SessionStart hooks for claude session history tracking
      if (hookType === 'SessionStart' && msg.payload && typeof msg.payload === 'object') {
        const claudeSessionId = 'session_id' in msg.payload ? String(msg.payload.session_id) : ''
        const source = 'source' in msg.payload ? String(msg.payload.source) : 'startup'
        if (claudeSessionId) {
          sessionManager.handleClaudeSessionStart(msg.surfaceId, claudeSessionId, source)
          const hookCwd = sessionManager.getCwd(msg.surfaceId)
          if (hookCwd) {
            sessionFileWatcher.watch(msg.surfaceId, claudeSessionId, hookCwd)
          }
        }
        // Compaction finished — Claude is now idle waiting for input
        if (source === 'compact') {
          queueTransition(msg.surfaceId, 'stopped', 'hook', 'hook:SessionStart:compact', hookTime)
        }
      }
      break
    }

    case 'emit-markdown': {
      const parentNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!parentNodeId) {
        console.error(`[emit-markdown] Unknown surfaceId: ${msg.surfaceId}`)
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

    case 'generate-image': {
      const giParentNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!giParentNodeId) {
        console.error(`[generate-image] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      const giPos = computePlacement(
        stateManager.getState().nodes,
        giParentNodeId,
        { width: msg.width, height: msg.height }
      )
      stateManager.createImage(giParentNodeId, giPos.x, giPos.y, msg.filePath, msg.width, msg.height)
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
        const spawnOptions = buildClaudeCodeCreateOptions(spawnCwd, undefined, fullPrompt)
        const { sessionId: spawnSessionId, cols: spawnCols, rows: spawnRows } = sessionManager.create(spawnOptions)
        snapshotManager.addSession(spawnSessionId, spawnCols, spawnRows)
        const spawnPos = computePlacement(stateManager.getState().nodes, spawnParentNodeId, terminalPixelSize(spawnCols, spawnRows))
        stateManager.createTerminal(spawnSessionId, spawnParentNodeId, spawnPos.x, spawnPos.y, spawnCols, spawnRows, spawnCwd, undefined, msg.title)
        console.log(`[spawn-claude-surface] Created terminal "${msg.title}" parented to ${spawnParentNodeId.slice(0, 8)}`)
      } catch (err: any) {
        console.error(`[spawn-claude-surface] Failed: ${err.message}`)
      }
      break
    }

    case 'status-line': {
      const logEntry =
        JSON.stringify({
          timestamp: localISOTimestamp(),
          type: 'status-line',
          payload: msg.payload
        }) + '\n'
      const slLogPath = path.join(HOOK_LOG_DIR, `${msg.surfaceId}.jsonl`)
      fs.appendFile(slLogPath, logEntry, (err) => {
        if (err) {
          console.error(`Failed to write status-line log: ${err.message}`)
          send(client.socket, { type: 'server-error', message: `Failed to write status-line log: ${err.message}` })
        }
      })

      // Extract context window usage and calculate remaining %
      const cw = msg.payload?.context_window as Record<string, unknown> | undefined
      if (cw) {
        const usage = cw.current_usage as Record<string, number> | undefined
        const contextWindowSize = cw.context_window_size as number | undefined
        if (usage && contextWindowSize) {
          const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0)
            + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0)
          const effectiveSize = contextWindowSize - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS
          const remainingPercent = (1 - totalTokens / effectiveSize) * 100
          sessionManager.setClaudeContextPercent(msg.surfaceId, remainingPercent)
        }
      }
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
      deleteGeneratedImageFile(node)
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
        const latestClaudeId = history.length > 0 ? history[history.length - 1].claudeSessionId : undefined
        if (latestClaudeId) {
          try {
            const restoreOptions = buildClaudeCodeCreateOptions(restoredNode.cwd, latestClaudeId, undefined, undefined, parseExtraCliArgs(restoredNode.extraCliArgs))
            const { sessionId: newPtyId, cols, rows } = sessionManager.create(restoreOptions)
            snapshotManager.addSession(newPtyId, cols, rows)
            if (restoredNode.shellTitleHistory?.length) {
              sessionManager.seedTitleHistory(newPtyId, restoredNode.shellTitleHistory)
            }
            stateManager.reincarnateTerminal(msg.archivedNodeId, newPtyId, cols, rows)
            client.attachedSessions.add(newPtyId)
            send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols, rows })
            console.log(`[unarchive] Reincarnated terminal ${msg.archivedNodeId.slice(0, 8)} with Claude session ${latestClaudeId.slice(0, 8)}`)
          } catch (err: any) {
            console.error(`[unarchive] Failed to reincarnate terminal ${msg.archivedNodeId.slice(0, 8)}: ${err.message}`)
            stateManager.archiveTerminal(msg.archivedNodeId)
            send(client.socket, { type: 'mutation-ack', seq: msg.seq })
          }
        } else {
          // No Claude session — archive it back
          stateManager.archiveTerminal(msg.archivedNodeId)
          send(client.socket, { type: 'mutation-ack', seq: msg.seq })
        }
      } else {
        send(client.socket, { type: 'mutation-ack', seq: msg.seq })
      }
      break
    }

    case 'node-archive-delete': {
      const archived = stateManager.peekArchivedNode(msg.parentNodeId, msg.archivedNodeId)
      deleteGeneratedImageFile(archived)
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

    case 'terminal-create': {
      try {
        let options: CreateOptions | undefined
        if (msg.options?.claude) {
          const prompt = msg.options.claude.prompt
            ?? gatherAncestorPrompt(stateManager.getState().nodes, msg.parentId)
          options = buildClaudeCodeCreateOptions(msg.options.cwd, msg.options.claude.resumeSessionId, prompt, msg.options.claude.appendSystemPrompt)
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
        stateManager.createTerminal(sessionId, msg.parentId, posX, posY, cols, rows, cwd, msg.initialTitleHistory, msg.initialName)
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
      const ptyId = tNode && tNode.type === 'terminal' ? tNode.sessionId : msg.nodeId
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
        let rOptions: CreateOptions | undefined
        if (msg.options?.claude) {
          rOptions = buildClaudeCodeCreateOptions(msg.options.cwd, msg.options.claude.resumeSessionId, msg.options.claude.prompt, msg.options.claude.appendSystemPrompt)
        } else {
          rOptions = msg.options
        }
        const { sessionId: newPtyId, cols: rCols, rows: rRows } = sessionManager.create(rOptions)
        snapshotManager.addSession(newPtyId, rCols, rRows)
        // Seed the new PTY session with the remnant's title history before reincarnation
        if (rNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(newPtyId, rNode.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(msg.nodeId, newPtyId, rCols, rRows)
        // Auto-attach client to the new PTY session
        client.attachedSessions.add(newPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols: rCols, rows: rRows })
      } catch (err: any) {
        console.error(`terminal-reincarnate failed: ${err.message}`)
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
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: DIRECTORY_WIDTH, height: DIRECTORY_HEIGHT })
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
      const hint = (msg.x != null && msg.y != null) ? { x: msg.x, y: msg.y } : undefined
      const mdPos = computePlacement(
        stateManager.getState().nodes,
        msg.parentId,
        { width: MARKDOWN_DEFAULT_WIDTH, height: MARKDOWN_DEFAULT_HEIGHT },
        hint
      )
      const mdParent = stateManager.getNode(msg.parentId)
      const mdFileBacked = mdParent?.type === 'file'
      const mdNode = stateManager.createMarkdown(msg.parentId, mdPos.x, mdPos.y, undefined, mdFileBacked || undefined)
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

    case 'image-add': {
      try {
        const imgWidth = msg.width ?? IMAGE_DEFAULT_WIDTH
        const imgHeight = msg.height ?? IMAGE_DEFAULT_HEIGHT
        let posX: number
        let posY: number
        if (msg.x != null && msg.y != null) {
          posX = msg.x
          posY = msg.y
        } else {
          const pos = computePlacement(stateManager.getState().nodes, msg.parentId, { width: imgWidth, height: imgHeight })
          posX = pos.x
          posY = pos.y
        }
        const imgNode = stateManager.createImage(msg.parentId, posX, posY, msg.filePath, msg.width, msg.height)
        send(client.socket, { type: 'node-add-ack', seq: msg.seq, nodeId: imgNode.id })
      } catch (err: any) {
        console.error(`image-add failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `image-add failed: ${err.message}` })
      }
      break
    }

    case 'set-claude-status-unread': {
      sessionManager.setClaudeStatusUnread(msg.sessionId, msg.unread)
      decisionLogger.log(msg.sessionId, {
        timestamp: localISOTimestamp(),
        source: 'client',
        event: msg.unread ? 'client:markUnread' : 'client:markRead',
        prevState: sessionManager.getClaudeState(msg.sessionId),
        newState: sessionManager.getClaudeState(msg.sessionId),
        unread: msg.unread
      })
      break
    }

    case 'fork-session': {
      try {
        const forkNode = stateManager.getNode(msg.nodeId)
        if (!forkNode || forkNode.type !== 'terminal') {
          send(client.socket, { type: 'server-error', message: `fork-session: node ${msg.nodeId} is not a terminal` })
          break
        }
        const history = forkNode.claudeSessionHistory ?? []
        if (history.length === 0) {
          send(client.socket, { type: 'server-error', message: `fork-session: no Claude session history` })
          break
        }
        const sourceClaudeSessionId = history[history.length - 1].claudeSessionId
        const forkCwd = forkNode.cwd ?? sessionManager.getCwd(forkNode.sessionId)
        if (!forkCwd) {
          send(client.socket, { type: 'server-error', message: `fork-session: cannot determine cwd` })
          break
        }

        const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId, forkNode.name)
        const forkOptions = buildClaudeCodeCreateOptions(forkCwd, newClaudeSessionId, undefined, undefined, parseExtraCliArgs(forkNode.extraCliArgs))
        const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
        snapshotManager.addSession(forkPtyId, forkCols, forkRows)

        const forkParentId = msg.nodeId
        const forkPos = computePlacement(stateManager.getState().nodes, forkParentId, terminalPixelSize(forkCols, forkRows))
        const forkName = forkNode.name ? `${forkNode.name} (Fork)` : undefined
        stateManager.createTerminal(forkPtyId, forkParentId, forkPos.x, forkPos.y, forkCols, forkRows, forkCwd, undefined, forkName)

        client.attachedSessions.add(forkPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: forkPtyId, cols: forkCols, rows: forkRows })
        console.log(`[fork-session] Forked terminal ${msg.nodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (claude session ${newClaudeSessionId.slice(0, 8)})`)
      } catch (err: any) {
        console.error(`fork-session failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `fork-session failed: ${err.message}` })
      }
      break
    }

    case 'terminal-restart': {
      try {
        const restartNode = stateManager.getNode(msg.nodeId)
        if (!restartNode || restartNode.type !== 'terminal' || !restartNode.alive) {
          send(client.socket, { type: 'server-error', message: `terminal-restart: node ${msg.nodeId} is not an alive terminal` })
          break
        }
        const restartCwd = restartNode.cwd ?? sessionManager.getCwd(restartNode.sessionId)

        // Update extraCliArgs on the node
        stateManager.updateExtraCliArgs(msg.nodeId, msg.extraCliArgs)

        // Mark as restarting so terminalExited skips archival
        stateManager.markRestarting(msg.nodeId)

        // Destroy old PTY and clean up
        const oldSessionId = restartNode.sessionId
        snapshotManager.removeSession(oldSessionId)
        sessionFileWatcher.unwatch(oldSessionId)
        sessionManager.destroy(oldSessionId)
        clients.forEach((c) => {
          c.attachedSessions.delete(oldSessionId)
          c.snapshotSessions.delete(oldSessionId)
        })

        // Get latest Claude session ID for resume
        const restartHistory = restartNode.claudeSessionHistory ?? []
        const restartClaudeId = restartHistory.length > 0 ? restartHistory[restartHistory.length - 1].claudeSessionId : undefined

        // Build new PTY with (potentially new) extra args
        const extraArgs = parseExtraCliArgs(msg.extraCliArgs)
        const restartOptions = buildClaudeCodeCreateOptions(restartCwd, restartClaudeId, undefined, undefined, extraArgs)
        const { sessionId: newPtyId, cols: restartCols, rows: restartRows } = sessionManager.create(restartOptions)
        snapshotManager.addSession(newPtyId, restartCols, restartRows)
        if (restartNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(newPtyId, restartNode.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(msg.nodeId, newPtyId, restartCols, restartRows)

        // Auto-attach client
        client.attachedSessions.add(newPtyId)
        send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols: restartCols, rows: restartRows })
        console.log(`[terminal-restart] Restarted terminal ${msg.nodeId.slice(0, 8)} with new session ${newPtyId.slice(0, 8)} extraCliArgs=${msg.extraCliArgs || '(none)'}`)
      } catch (err: any) {
        console.error(`terminal-restart failed: ${err.message}`)
        send(client.socket, { type: 'server-error', message: `terminal-restart failed: ${err.message}` })
      }
      break
    }

    default: {
      const unknownType = (msg as any).type
      console.error(`Unknown message type: ${unknownType}`)
      send(client.socket, { type: 'server-error', message: `Unknown message type: ${unknownType}` })
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

  sessionManager = new SessionManager(
    // onData: broadcast to attached clients + feed snapshot manager
    (sessionId, data) => {
      snapshotManager.write(sessionId, data)
      broadcastToAttached(sessionId, { type: 'data', sessionId, data })
    },
    // onExit: broadcast to all attached clients + update state
    (sessionId, exitCode) => {
      sessionFileWatcher.unwatch(sessionId)
      snapshotManager.removeSession(sessionId)
      lastActivityBySurface.delete(sessionId)
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
    },
    // onClaudeContext: broadcast context remaining % to all attached clients
    (sessionId, contextRemainingPercent) => {
      broadcastToAttached(sessionId, { type: 'claude-context', sessionId, contextRemainingPercent })
    },
    // onClaudeSessionLineCount: broadcast JSONL line count to all attached clients
    (sessionId, lineCount) => {
      broadcastToAttached(sessionId, { type: 'claude-session-line-count', sessionId, lineCount })
    },
    // onClaudeStatusUnread: update state manager (node-updated broadcast handles client sync)
    (sessionId, unread) => {
      stateManager.updateClaudeStatusUnread(sessionId, unread)
    }
  )

  // Initialize DecisionLogger — per-surface JSONL log of state transition decisions
  decisionLogger = new DecisionLogger()

  // Initialize PlanCacheManager — caches plan file revisions for diffing
  planCacheManager = new PlanCacheManager()

  // Start the transition queue drain — processes queued state transitions every 50ms
  transitionDrainTimer = setInterval(drainTransitionQueue, TRANSITION_DRAIN_INTERVAL_MS)

  // Start the stale surface sweep — detects stuck sessions every 15s
  staleSweepTimer = setInterval(sweepStaleSurfaces, STALE_SWEEP_INTERVAL_MS)

  // Initialize SessionFileWatcher — watches Claude session JSONL files for line count + state routing
  sessionFileWatcher = new SessionFileWatcher((surfaceId, newEntries, totalLineCount, isBackfill) => {
    sessionManager.setClaudeSessionLineCount(surfaceId, totalLineCount)

    // During backfill, only track plan file paths (so the path is ready for
    // future live snapshots). Don't snapshot — the file on disk only has its
    // latest content, so backfill snapshots would be misleading.
    if (isBackfill) {
      for (const entry of newEntries) {
        if (entry.type !== 'assistant') continue
        const assistantContent = (entry.message as any)?.content
        if (!Array.isArray(assistantContent)) continue
        for (const block of assistantContent) {
          if (block.type === 'tool_use' &&
              (block.name === 'Write' || block.name === 'Edit') &&
              typeof block.input?.file_path === 'string' &&
              block.input.file_path.includes('/.claude/plans/')) {
            planCacheManager.trackPlanFile(surfaceId, block.input.file_path)
          }
        }
      }
      return
    }

    for (const entry of newEntries) {
      // Parse source timestamp from the JSONL entry (falls back to now if missing/invalid)
      const entryTime = typeof entry.timestamp === 'string'
        ? new Date(entry.timestamp as string).getTime() || Date.now()
        : Date.now()

      // Assistant message → Claude is actively producing output
      if (entry.type === 'assistant') {
        // Scan tool_use blocks for plan file writes and ExitPlanMode
        const assistantContent = (entry.message as any)?.content
        if (Array.isArray(assistantContent)) {
          for (const block of assistantContent) {
            if (block.type !== 'tool_use') continue
            if ((block.name === 'Write' || block.name === 'Edit') &&
                typeof block.input?.file_path === 'string' &&
                block.input.file_path.includes('/.claude/plans/')) {
              planCacheManager.trackPlanFile(surfaceId, block.input.file_path)
            }
            if (block.name === 'ExitPlanMode') {
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
        queueTransition(surfaceId, 'working', 'jsonl', 'jsonl:assistant', entryTime)
        continue
      }

      if (entry.type === 'user') {
        // Skip injected meta context (skills, system reminders)
        if (entry.isMeta) continue

        const msg = entry.message as { content: unknown } | undefined
        if (!msg) continue

        // Human-typed message (string content) → working
        if (typeof msg.content === 'string') {
          queueTransition(surfaceId, 'working', 'jsonl', 'jsonl:user:string', entryTime)
          continue
        }

        // Array content = tool results
        if (Array.isArray(msg.content)) {
          const toolUseResult = entry.toolUseResult

          // User interrupted/aborted a tool
          if (typeof toolUseResult === 'string' && toolUseResult.includes('interrupted by user')) {
            queueTransition(surfaceId, 'stopped', 'jsonl', 'jsonl:user:interrupt', entryTime)
            continue
          }

          // User rejected a permission prompt — Claude Code doesn't fire PostToolUse
          // or PostToolUseFailure for rejections, so the JSONL entry is our only signal.
          // Default to stopped: if Claude continues, jsonl:assistant will correct to working.
          if (typeof toolUseResult === 'string' && toolUseResult.includes('rejected')) {
            queueTransition(surfaceId, 'stopped', 'jsonl', 'jsonl:user:rejected', entryTime)
            continue
          }

          // Check content for interrupt text (covers cases where toolUseResult is null
          // but the entry content carries the interrupt signal, e.g. the second entry
          // Claude Code writes after a permission rejection)
          const contentArr = msg.content as Array<{ type?: string; text?: string }>
          if (contentArr.some(item => item.type === 'text' && typeof item.text === 'string' && item.text.includes('interrupted by user'))) {
            queueTransition(surfaceId, 'stopped', 'jsonl', 'jsonl:user:interrupt:content', entryTime)
            continue
          }

          // Non-interrupt, non-rejection tool results: don't change state (hooks handle it)
        }
      }
    }
  })

  // --- Startup revival: revive terminals with Claude sessions, archive the rest ---
  const deadTerminals = stateManager.processDeadTerminals()
  for (const { nodeId, claudeSessionId, cwd, extraCliArgs } of deadTerminals) {
    if (claudeSessionId) {
      try {
        const reviveOptions = buildClaudeCodeCreateOptions(cwd, claudeSessionId, undefined, undefined, parseExtraCliArgs(extraCliArgs))
        const { sessionId, cols, rows } = sessionManager.create(reviveOptions)
        snapshotManager.addSession(sessionId, cols, rows)
        const revivingNode = stateManager.getNode(nodeId)
        if (revivingNode?.type === 'terminal' && revivingNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(sessionId, revivingNode.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(nodeId, sessionId, cols, rows)
        const revivalCwd = sessionManager.getCwd(sessionId)
        if (revivalCwd) {
          sessionFileWatcher.watch(sessionId, claudeSessionId, revivalCwd)
        }
        console.log(`[startup] Revived terminal ${nodeId.slice(0, 8)} with Claude session ${claudeSessionId.slice(0, 8)}`)
      } catch (err: any) {
        console.error(`[startup] Failed to revive terminal ${nodeId.slice(0, 8)}: ${err.message}`)
        stateManager.archiveTerminal(nodeId)
      }
    } else {
      stateManager.archiveTerminal(nodeId)
      console.log(`[startup] Archived terminal ${nodeId.slice(0, 8)} (no Claude session)`)
    }
  }

  // --- Git status polling for directory nodes ---
  gitStatusPoller = new GitStatusPoller(
    () => stateManager.getDirectoryNodes(),
    (nodeId, gitStatus) => stateManager.updateDirectoryGitStatus(nodeId, gitStatus)
  )

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
    if (staleSweepTimer) clearInterval(staleSweepTimer)
    if (transitionDrainTimer) clearInterval(transitionDrainTimer)
    // Flush any remaining queued transitions before persisting state
    drainTransitionQueue(true)
    gitStatusPoller.dispose()
    fileContentManager.dispose()
    sessionFileWatcher.dispose()
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
