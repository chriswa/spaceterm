import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { execFile, spawn } from 'child_process'
import { homedir } from 'os'
import { SOCKET_DIR, SOCKET_PATH, HOOKS_SOCKET_PATH, SCRIPTS_SOCKET_PATH, HOOK_LOG_DIR } from '../shared/protocol'
import type { ClientMessage, IngestMessage, ScriptMessage, ScriptResponse, ServerMessage, CreateOptions, GhRateLimitData } from '../shared/protocol'
import { SessionManager } from './session-manager'
import { DaemonClient } from './daemon-client'
import { StateManager } from './state-manager'
import { SnapshotManager } from './snapshot-manager'
import { canFitAt, computePlacement } from './node-placement'
import { nodePixelSize, terminalPixelSize, directoryFolderWidth, MARKDOWN_DEFAULT_WIDTH, MARKDOWN_DEFAULT_HEIGHT, DIRECTORY_HEIGHT, FILE_WIDTH, FILE_HEIGHT, TITLE_DEFAULT_WIDTH, TITLE_HEIGHT } from '../shared/node-size'
import { setupShellIntegration } from './shell-integration'
import { LineParser } from './line-parser'
import { SessionFileWatcher } from './session-file-watcher'
import { ClaudeStateMachine } from './claude-state'
import { localISOTimestamp } from './timestamp'
import { FileContentManager } from './file-content-manager'
import { GitStatusPoller } from './git-status-poller'
import { PlanCacheManager } from './plan-cache'
import { resolveFilePath, getAncestorCwd } from './path-utils'
import { forkSession, computeForkName, sessionFilePath } from './session-fork'
import { fetchClaudeUsage, type ClaudeUsageData } from './claude-usage'
import { parse as shellParse } from 'shell-quote'
import { AutoContinueManager } from './auto-continue'
import { SessionTitleSummarizer } from './session-title-summarizer'

/**
 * Claude Code reserves this many tokens as a buffer before triggering autocompact.
 * The effective context window = context_window_size - this buffer.
 * UPDATE THIS when Claude Code changes its compaction threshold.
 */
const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 33_000

/** Spaceterm project root (two levels up from src/server/). */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

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

/**
 * Sanitize a string that may contain terminal escape/control sequences so it
 * can be safely logged to stdout/stderr without the host terminal interpreting
 * those sequences (which could change keyboard mode, cursor visibility, etc.).
 * Replaces non-printable characters with visible representations while
 * preserving \n, \r, and \t for readability.
 */
function sanitizeForLog(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      const code = ch.charCodeAt(0)
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
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
    // which otherwise causes the banner to appear twice — a known PTY echo issue.
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

/**
 * Walk backwards through a terminal's claude session history to find the most
 * recent session whose JSONL file still exists on disk.  Returns `undefined`
 * if no valid session can be found (or if cwd is missing so we can't check).
 *
 * Ghost session IDs accumulate when a previous revival starts Claude Code,
 * Claude fires a SessionStart hook (registering a new session), but then
 * crashes before writing the JSONL.  Without this check the revival enters a
 * cascading failure: every restart picks the ghost and fails again.
 */
function findValidClaudeSession(history: Array<{ claudeSessionId: string }>, cwd: string | undefined): string | undefined {
  if (!cwd || history.length === 0) {
    return history.length > 0 ? history[history.length - 1].claudeSessionId : undefined
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const id = history[i].claudeSessionId
    if (fs.existsSync(sessionFilePath(cwd, id))) return id
  }
  return undefined
}

interface ClientConnection {
  socket: net.Socket
  attachedSessions: Set<string>
  /** Sessions where this client wants snapshot mode instead of live data */
  snapshotSessions: Set<string>
  parser: LineParser
}

/** Tracks manual restarts for auto-recovery when the new PTY exits quickly. */
const restartRecovery = new Map<string, {
  restartedAt: number
  newSessionId: string
  previousExtraCliArgs: string
  isRetry: boolean
}>()

const clients = new Set<ClientConnection>()

// --- Claude usage polling state ---
const USAGE_POLL_TICK_MS = 15_000     // check conditions every 15s
const USAGE_FETCH_COOLDOWN_MS = 1 * 60_000 // never fetch more than once per 1 minute
const USAGE_IDLE_TIMEOUT_MS = 5 * 60_000 // stop fetching after 5 min of no client commands
let lastClientCommandAt = 0
let lastUsageFetchAt = 0
const USAGE_LOG_DIR = path.join(SOCKET_DIR, 'usage-logs')
const USAGE_CACHE_FILE = path.join(SOCKET_DIR, 'usage-cache.json')

// --- Minute-keyed ring buffer (reusable for any monotonic time-series) ---
const HISTORY_SLOTS = 61

class MinuteRingBuffer {
  private slots: ({ minuteKey: number; value: number } | null)[]
  private seeded = false
  private label: string

  constructor(label: string) {
    this.label = label
    this.slots = new Array(HISTORY_SLOTS).fill(null)
  }

  record(value: number, now = Date.now()): void {
    const minuteKey = Math.floor(now / 60_000)
    const slotIndex = ((minuteKey % HISTORY_SLOTS) + HISTORY_SLOTS) % HISTORY_SLOTS
    this.slots[slotIndex] = { minuteKey, value }
  }

  build(): (number | null)[] {
    const nowMinute = Math.floor(Date.now() / 60_000)
    const result: (number | null)[] = []
    for (let i = HISTORY_SLOTS - 1; i >= 0; i--) {
      const targetMinute = nowMinute - i
      const slotIndex = ((targetMinute % HISTORY_SLOTS) + HISTORY_SLOTS) % HISTORY_SLOTS
      const slot = this.slots[slotIndex]
      result.push(slot && slot.minuteKey === targetMinute ? slot.value : null)
    }
    return result
  }

  seedFromLog(logFile: string, valueKey: string): void {
    if (this.seeded) return
    this.seeded = true
    try {
      if (!fs.existsSync(logFile)) return
      const fd = fs.openSync(logFile, 'r')
      const stat = fs.fstatSync(fd)
      const readSize = Math.min(stat.size, 4096)
      const buf = Buffer.alloc(readSize)
      fs.readSync(fd, buf, 0, readSize, stat.size - readSize)
      fs.closeSync(fd)

      const cutoffMinute = Math.floor(Date.now() / 60_000) - HISTORY_SLOTS
      const lines = buf.toString('utf8').split('\n').filter(Boolean)
      const startIdx = stat.size > readSize ? 1 : 0
      for (let i = startIdx; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i])
          const value = entry[valueKey]
          if (typeof value !== 'number' || !entry.timestamp) continue
          const minuteKey = Math.floor(new Date(entry.timestamp).getTime() / 60_000)
          if (minuteKey <= cutoffMinute) continue
          this.record(value, minuteKey * 60_000)
        } catch { /* skip malformed line */ }
      }
      console.log(`[${this.label}] Seeded history from log (${lines.length - startIdx} entries scanned)`)
    } catch (err: any) {
      console.error(`[${this.label}] Failed to seed history: ${err.message}`)
    }
  }
}

const creditHistory = new MinuteRingBuffer('claude-usage')
const fiveHourHistory = new MinuteRingBuffer('5h-usage')
const sevenDayHistory = new MinuteRingBuffer('7d-usage')
const ghRateLimitHistory = new MinuteRingBuffer('gh-rate-limit')

// Cached last usage response — sent immediately to newly connected clients
let cachedUsage: { usage: ClaudeUsageData; subscriptionType: string; rateLimitTier: string } | null = null

function loadCachedUsage(): void {
  try {
    if (!fs.existsSync(USAGE_CACHE_FILE)) return
    const data = JSON.parse(fs.readFileSync(USAGE_CACHE_FILE, 'utf8'))
    if (data?.usage && data?.subscriptionType && data?.rateLimitTier) {
      cachedUsage = data
      // Seed history buffers from the log now that we know the subscription type
      const logFile = path.join(USAGE_LOG_DIR, `usage_${data.subscriptionType}.jsonl`)
      creditHistory.seedFromLog(logFile, 'extra_usage.used_credits')
      fiveHourHistory.seedFromLog(logFile, 'five_hour.utilization')
      sevenDayHistory.seedFromLog(logFile, 'seven_day.utilization')
      console.log(`[claude-usage] Loaded cached usage (${data.subscriptionType})`)
    }
  } catch (err: any) {
    console.error(`[claude-usage] Failed to load usage cache: ${err.message}`)
  }
}

function saveCachedUsage(usage: ClaudeUsageData, subscriptionType: string, rateLimitTier: string): void {
  cachedUsage = { usage, subscriptionType, rateLimitTier }
  fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(cachedUsage), (err) => {
    if (err) console.error(`[claude-usage] Failed to save usage cache: ${err.message}`)
  })
}

// --- GitHub GraphQL rate limit polling ---
const GH_RATE_LIMIT_POLL_MS = 60_000 // every 1 minute
const GH_RATE_LIMIT_LOG_FILE = path.join(USAGE_LOG_DIR, 'gh_rate_limit.jsonl')
const GH_RATE_LIMIT_CACHE_FILE = path.join(SOCKET_DIR, 'gh-rate-limit-cache.json')
let cachedGhRateLimit: GhRateLimitData | null = null

function loadCachedGhRateLimit(): void {
  try {
    if (fs.existsSync(GH_RATE_LIMIT_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(GH_RATE_LIMIT_CACHE_FILE, 'utf8'))
      if (data && typeof data.limit === 'number' && typeof data.used === 'number' && typeof data.resetAt === 'string') {
        cachedGhRateLimit = data
        console.log(`[gh-rate-limit] Loaded cached data (${data.used}/${data.limit})`)
      }
    }
  } catch (err: any) {
    console.error(`[gh-rate-limit] Failed to load cache: ${err.message}`)
  }
  ghRateLimitHistory.seedFromLog(GH_RATE_LIMIT_LOG_FILE, 'used')
}

function saveCachedGhRateLimit(data: GhRateLimitData): void {
  cachedGhRateLimit = data
  fs.writeFile(GH_RATE_LIMIT_CACHE_FILE, JSON.stringify(data), (err) => {
    if (err) console.error(`[gh-rate-limit] Failed to save cache: ${err.message}`)
  })
}

function fetchGhRateLimit(): Promise<GhRateLimitData> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', 'graphql', '-f', 'query={ rateLimit { limit remaining resetAt } }'],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return reject(new Error(`gh api failed: ${err.message}`))
        try {
          const parsed = JSON.parse(stdout)
          const rl = parsed?.data?.rateLimit
          if (!rl || typeof rl.limit !== 'number' || typeof rl.remaining !== 'number' || typeof rl.resetAt !== 'string') {
            return reject(new Error('Unexpected gh rate limit response shape'))
          }
          resolve({ limit: rl.limit, used: rl.limit - rl.remaining, resetAt: rl.resetAt })
        } catch (e: any) {
          reject(new Error(`Failed to parse gh response: ${e.message}`))
        }
      }
    )
  })
}

let daemonClient: DaemonClient
let sessionManager: SessionManager
let stateManager: StateManager
let snapshotManager: SnapshotManager
let sessionFileWatcher: SessionFileWatcher
let fileContentManager: FileContentManager
let gitStatusPoller: GitStatusPoller
let planCacheManager: PlanCacheManager
let claudeStateMachine: ClaudeStateMachine
let autoContinueManager: AutoContinueManager
let sessionTitleSummarizer: SessionTitleSummarizer

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

/** Pending fork-settle callbacks: surfaceId → { respond, timeoutId }. */
interface PendingForkSettle {
  respond: (error?: string) => void
  timeoutId: ReturnType<typeof setTimeout>
}
const pendingForkSettles = new Map<string, PendingForkSettle>()

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

      // Process SessionStart hooks for claude session history tracking
      // (session lifecycle management stays here — not state machine concern)
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

      // Generate auto-summary title on UserPromptSubmit (fire-and-forget)
      if (hookType === 'UserPromptSubmit' && msg.payload && typeof msg.payload === 'object') {
        const transcriptPath = 'transcript_path' in msg.payload ? String(msg.payload.transcript_path) : ''
        const claudeSessionId = 'session_id' in msg.payload ? String(msg.payload.session_id) : ''
        if (transcriptPath) {
          sessionTitleSummarizer.summarize(msg.surfaceId, transcriptPath, claudeSessionId)
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

    case 'spaceterm-broadcast': {
      const broadcastNodeId = stateManager.getNodeIdForSession(msg.surfaceId)
      if (!broadcastNodeId) {
        console.error(`[spaceterm-broadcast] Unknown surfaceId: ${msg.surfaceId}`)
        break
      }
      broadcastToScriptSubscribers('broadcast', broadcastNodeId, {
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

      // Extract model display name
      const model = msg.payload?.model as { display_name?: string } | undefined
      if (model?.display_name) {
        stateManager.updateClaudeModel(msg.surfaceId, model.display_name)
      }
      break
    }
  }
}

// --- Script socket (scripts.sock) ---

interface ScriptSubscriber {
  socket: net.Socket
  events: Set<string> | null   // null = all events
  nodeIds: Set<string> | null  // null = all nodes
}
const scriptSubscribers = new Set<ScriptSubscriber>()

function broadcastToScriptSubscribers(eventType: string, nodeId: string | undefined, msg: Record<string, unknown>): void {
  scriptSubscribers.forEach((sub) => {
    if (sub.events && !sub.events.has(eventType)) return
    if (sub.nodeIds && nodeId && !sub.nodeIds.has(nodeId)) return
    try {
      sub.socket.write(JSON.stringify(msg) + '\n')
    } catch {
      // Disconnected — will be cleaned up by 'close'/'error' handler
    }
  })
}

function handleScriptMessage(socket: net.Socket, msg: ScriptMessage): void {
  const sendAndClose = (resp: ScriptResponse): void => {
    try {
      socket.write(JSON.stringify(resp) + '\n')
    } catch { /* disconnected */ }
    socket.end()
  }

  switch (msg.type) {
    case 'script-get-ancestors': {
      const node = stateManager.getNode(msg.nodeId)
      if (!node) {
        sendAndClose({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors: [], error: 'unknown-node' })
        return
      }
      const ancestors: string[] = [node.id]
      let currentId = node.parentId
      const visited = new Set<string>()
      while (currentId && currentId !== 'root' && !visited.has(currentId)) {
        visited.add(currentId)
        const ancestor = stateManager.getNode(currentId)
        if (!ancestor) break
        ancestors.push(ancestor.id)
        currentId = ancestor.parentId
      }
      sendAndClose({ type: 'script-get-ancestors-result', seq: msg.seq, ancestors })
      break
    }

    case 'script-get-node': {
      const node = stateManager.getNode(msg.nodeId)
      if (!node) {
        sendAndClose({ type: 'script-get-node-result', seq: msg.seq, error: 'unknown-node' })
        return
      }
      const stripped = { ...node, archivedChildren: [] as [] }
      sendAndClose({ type: 'script-get-node-result', seq: msg.seq, node: stripped })
      break
    }

    case 'script-ship-it': {
      const node = stateManager.getNode(msg.nodeId)
      if (!node) {
        sendAndClose({ type: 'script-ship-it-result', seq: msg.seq, ok: false, error: 'unknown-node' })
        return
      }
      if (node.type !== 'terminal') {
        sendAndClose({ type: 'script-ship-it-result', seq: msg.seq, ok: false, error: 'not-a-terminal' })
        return
      }
      if (!node.alive) {
        sendAndClose({ type: 'script-ship-it-result', seq: msg.seq, ok: false, error: 'terminal-not-alive' })
        return
      }

      const targetSessionId = node.sessionId
      const content = msg.data.replace(/\r?\n/g, '\r')
      sessionManager.write(targetSessionId, '\x1b[200~' + content + '\x1b[201~')
      claudeStateMachine.handleClientWrite(targetSessionId, false)
      autoContinueManager.cancelForSurface(targetSessionId)

      const submit = msg.submit !== false  // default true
      if (submit) {
        setTimeout(() => {
          sessionManager.write(targetSessionId, '\r')
          claudeStateMachine.handleClientWrite(targetSessionId, true)
        }, 1000)
      }

      sendAndClose({ type: 'script-ship-it-result', seq: msg.seq, ok: true })
      break
    }

    case 'script-subscribe': {
      const events = msg.events ? new Set(msg.events) : null
      const nodeIds = msg.nodeIds ? new Set(msg.nodeIds) : null
      const sub: ScriptSubscriber = { socket, events, nodeIds }
      scriptSubscribers.add(sub)

      // Ack the subscription
      try {
        socket.write(JSON.stringify({ type: 'script-subscribe-result', seq: msg.seq, ok: true }) + '\n')
      } catch { /* disconnected */ }

      // Clean up on disconnect
      const cleanup = () => { scriptSubscribers.delete(sub) }
      socket.on('close', cleanup)
      socket.on('error', cleanup)
      // Do NOT call socket.end() — keep alive for event streaming
      break
    }

    case 'script-fork-claude': {
      const SETTLE_TIMEOUT_MS = 30_000
      const sendError = (error: string): void => {
        try {
          socket.write(JSON.stringify({ type: 'script-fork-claude-result', seq: msg.seq, nodeId: '', error }) + '\n')
        } catch { /* disconnected */ }
        socket.end()
      }

      try {
        const forkNode = stateManager.getNode(msg.nodeId)
        if (!forkNode || forkNode.type !== 'terminal') {
          sendError(`node ${msg.nodeId} is not a terminal`)
          break
        }
        const history = forkNode.claudeSessionHistory ?? []
        if (history.length === 0) {
          sendError('no Claude session history')
          break
        }
        const forkCwd = forkNode.cwd ?? sessionManager.getCwd(forkNode.sessionId)
        if (!forkCwd) {
          sendError('cannot determine cwd')
          break
        }
        // Walk backwards through history to find the most recent session with an
        // existing transcript file on disk.
        let sourceClaudeSessionId: string | undefined
        for (let i = history.length - 1; i >= 0; i--) {
          if (fs.existsSync(sessionFilePath(forkCwd, history[i].claudeSessionId))) {
            sourceClaudeSessionId = history[i].claudeSessionId
            break
          }
        }
        if (!sourceClaudeSessionId) {
          sendError('no session transcript file found on disk')
          break
        }

        const forkName = computeForkName(forkNode.name)
        const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId)
        const forkOptions = buildClaudeCodeCreateOptions(forkCwd, newClaudeSessionId, undefined, undefined, parseExtraCliArgs(forkNode.extraCliArgs))
        const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
        snapshotManager.addSession(forkPtyId, forkCols, forkRows)

        // Place the new terminal below the specified parent (not the source node)
        const forkPos = computePlacement(stateManager.getState().nodes, msg.parentId, terminalPixelSize(forkCols, forkRows))
        stateManager.createTerminal(forkPtyId, msg.parentId, forkPos.x, forkPos.y, forkCols, forkRows, forkCwd, forkNode.shellTitleHistory, forkName, msg.nodeId)
        if (forkNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(forkPtyId, forkNode.shellTitleHistory)
        }

        const newNodeId = forkPtyId
        let responded = false

        const respond = (error?: string): void => {
          if (responded) return
          responded = true
          pendingForkSettles.delete(forkPtyId)
          try {
            socket.write(JSON.stringify({
              type: 'script-fork-claude-result',
              seq: msg.seq,
              nodeId: error ? '' : newNodeId,
              error
            }) + '\n')
          } catch { /* disconnected */ }
          socket.end()
        }

        const timeoutId = setTimeout(
          () => respond('Timed out waiting for session to settle'),
          SETTLE_TIMEOUT_MS
        )
        pendingForkSettles.set(forkPtyId, { respond, timeoutId })

        console.log(`[script-fork-claude] Forked terminal ${msg.nodeId.slice(0, 8)} → ${forkPtyId.slice(0, 8)} (parent ${msg.parentId.slice(0, 8)}), waiting for settle...`)
      } catch (err: any) {
        console.error(`script-fork-claude failed: ${err.message}`)
        sendError(err.message)
      }
      break
    }

    case 'script-unread': {
      // Fire-and-forget: mark a terminal as unread. Silently no-ops for unknown/non-terminal nodes.
      const node = stateManager.getNode(msg.nodeId)
      if (node && node.type === 'terminal') {
        claudeStateMachine.handleClientMarkUnread(node.sessionId, true)
      }
      break
    }

    default: {
      const unknownType = (msg as unknown as Record<string, unknown>).type
      console.error(`[scripts] Unknown message type: ${unknownType}`)
      try {
        socket.write(JSON.stringify({ type: 'error', error: `Unknown message type: ${unknownType}` }) + '\n')
      } catch { /* disconnected */ }
      socket.end()
      break
    }
  }
}

function handleMessage(client: ClientConnection, msg: ClientMessage): void {
  lastClientCommandAt = Date.now()
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
      autoContinueManager.cancelForSurface(msg.sessionId)
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
      claudeStateMachine.handleClientWrite(msg.sessionId, msg.data === '\r')
      autoContinueManager.cancelForSurface(msg.sessionId)
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
        const validClaudeId = findValidClaudeSession(history, restoredNode.cwd)
        if (validClaudeId) {
          try {
            const restoreOptions = { ...buildClaudeCodeCreateOptions(restoredNode.cwd, validClaudeId, undefined, undefined, parseExtraCliArgs(restoredNode.extraCliArgs)), nodeId: msg.archivedNodeId }
            const { sessionId: newPtyId, cols, rows } = sessionManager.create(restoreOptions)
            snapshotManager.addSession(newPtyId, cols, rows)
            if (restoredNode.shellTitleHistory?.length) {
              sessionManager.seedTitleHistory(newPtyId, restoredNode.shellTitleHistory)
            }
            stateManager.reincarnateTerminal(msg.archivedNodeId, newPtyId, cols, rows)
            client.attachedSessions.add(newPtyId)
            send(client.socket, { type: 'created', seq: msg.seq, sessionId: newPtyId, cols, rows })
            console.log(`[unarchive] Reincarnated terminal ${msg.archivedNodeId.slice(0, 8)} with Claude session ${validClaudeId.slice(0, 8)}`)
          } catch (err: any) {
            console.error(`[unarchive] Failed to reincarnate terminal ${msg.archivedNodeId.slice(0, 8)}: ${err.message}`)
            stateManager.archiveTerminal(msg.archivedNodeId)
            send(client.socket, { type: 'mutation-ack', seq: msg.seq })
          }
        } else {
          // No valid Claude session — archive it back
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

    case 'undo-buffer-pop': {
      const entry = stateManager.popUndoEntry()
      send(client.socket, { type: 'undo-buffer-pop-result', seq: msg.seq, entry })
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
          rOptions = msg.options ? { ...msg.options } : undefined
        }
        // Pass stable nodeId so SPACETERM_NODE_ID survives reincarnation
        rOptions = { ...rOptions, nodeId: msg.nodeId }
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
      // NOTE: We intentionally do NOT cancel auto-continue here. The client
      // auto-clears the unread flag via useEffect whenever a surface is already
      // focused (235ms round-trip), which would kill the recovery timer before
      // the user has a chance to act. Real user intervention (typing into the
      // terminal) cancels via the 'write' handler instead.
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
        const history = forkNode.claudeSessionHistory ?? []
        if (history.length === 0) {
          send(client.socket, { type: 'server-error', message: `fork-session: no Claude session history` })
          break
        }
        const forkCwd = forkNode.cwd ?? sessionManager.getCwd(forkNode.sessionId)
        if (!forkCwd) {
          send(client.socket, { type: 'server-error', message: `fork-session: cannot determine cwd` })
          break
        }
        // Walk backwards through history to find the most recent session with an
        // existing transcript file. Claude Code fires a "startup" SessionStart hook
        // with a new session ID that may never get a .jsonl file on disk.
        let sourceClaudeSessionId: string | undefined
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

        const forkName = computeForkName(forkNode.name)
        const newClaudeSessionId = forkSession(forkCwd, sourceClaudeSessionId)
        const forkOptions = buildClaudeCodeCreateOptions(forkCwd, newClaudeSessionId, undefined, undefined, parseExtraCliArgs(forkNode.extraCliArgs))
        const { sessionId: forkPtyId, cols: forkCols, rows: forkRows } = sessionManager.create(forkOptions)
        snapshotManager.addSession(forkPtyId, forkCols, forkRows)

        const forkParentId = msg.nodeId
        const forkPos = computePlacement(stateManager.getState().nodes, forkParentId, terminalPixelSize(forkCols, forkRows))
        stateManager.createTerminal(forkPtyId, forkParentId, forkPos.x, forkPos.y, forkCols, forkRows, forkCwd, forkNode.shellTitleHistory, forkName, msg.nodeId)
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
        if (!restartNode || restartNode.type !== 'terminal' || !restartNode.alive) {
          send(client.socket, { type: 'server-error', message: `terminal-restart: node ${msg.nodeId} is not an alive terminal` })
          break
        }
        const restartCwd = restartNode.cwd ?? sessionManager.getCwd(restartNode.sessionId)

        // Capture previous extraCliArgs for recovery before updating
        const previousExtraCliArgs = restartNode.extraCliArgs ?? ''

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

        // Get latest valid Claude session ID for resume
        const restartHistory = restartNode.claudeSessionHistory ?? []
        const restartClaudeId = findValidClaudeSession(restartHistory, restartCwd)

        // Build new PTY with (potentially new) extra args
        const extraArgs = parseExtraCliArgs(msg.extraCliArgs)
        const restartOptions = { ...buildClaudeCodeCreateOptions(restartCwd, restartClaudeId, undefined, undefined, extraArgs), nodeId: msg.nodeId }
        const { sessionId: newPtyId, cols: restartCols, rows: restartRows } = sessionManager.create(restartOptions)
        snapshotManager.addSession(newPtyId, restartCols, restartRows)
        if (restartNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(newPtyId, restartNode.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(msg.nodeId, newPtyId, restartCols, restartRows)

        // Track for auto-recovery if the new PTY exits quickly
        restartRecovery.set(msg.nodeId, {
          restartedAt: Date.now(),
          newSessionId: newPtyId,
          previousExtraCliArgs,
          isRetry: false
        })

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

async function startServer(): Promise<void> {
  // Write shell integration scripts (OSC 7 hooks for CWD reporting)
  setupShellIntegration()

  // Ensure socket directory exists
  fs.mkdirSync(SOCKET_DIR, { recursive: true })
  fs.mkdirSync(HOOK_LOG_DIR, { recursive: true })

  // Remove stale socket files — but first check if another server is alive.
  // If we blindly unlink, we'd steal the socket from a running server: the running
  // server's FD stays open (existing connections work) but new connections (hooks
  // from freshly spawned Claude terminals) can't reach it, silently breaking
  // Claude surface detection.
  await cleanStaleSocket(SOCKET_PATH, true)
  await cleanStaleSocket(HOOKS_SOCKET_PATH, false)
  await cleanStaleSocket(SCRIPTS_SOCKET_PATH, false)

  // Initialize StateManager — broadcasts node changes to all clients and script subscribers
  stateManager = new StateManager(
    (nodeId, fields) => {
      broadcastToAll({ type: 'node-updated', nodeId, fields })
      broadcastToScriptSubscribers('node-updated', nodeId, { type: 'node-updated', nodeId, fields })
    },
    (node) => {
      broadcastToAll({ type: 'node-added', node })
      broadcastToScriptSubscribers('node-added', node.id, { type: 'node-added', node })
    },
    (nodeId) => {
      broadcastToAll({ type: 'node-removed', nodeId })
      broadcastToScriptSubscribers('node-removed', nodeId, { type: 'node-removed', nodeId })
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

  // Initialize DaemonClient — manages connection to the persistent PTY daemon
  daemonClient = new DaemonClient((msg) => {
    switch (msg.type) {
      case 'data':
        sessionManager.handleDaemonData(msg.id as string, msg.data as string)
        break
      case 'exit':
        sessionManager.handleDaemonExit(msg.id as string, msg.exitCode as number)
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

  sessionManager = new SessionManager(
    daemonClient,
    // onData: broadcast to attached clients + feed snapshot manager
    (sessionId, data) => {
      snapshotManager.write(sessionId, data)
      broadcastToAttached(sessionId, { type: 'data', sessionId, data })
    },
    // onExit: broadcast to all attached clients + update state
    (sessionId, exitCode) => {
      // If this PTY was awaiting fork-settle, fail it immediately
      const pendingFork = pendingForkSettles.get(sessionId)
      if (pendingFork) {
        clearTimeout(pendingFork.timeoutId)
        pendingForkSettles.delete(sessionId)
        pendingFork.respond(`Session exited with code ${exitCode} before settling`)
      }

      sessionFileWatcher.unwatch(sessionId)
      autoContinueManager.cancelForSurface(sessionId)
      snapshotManager.removeSession(sessionId)

      // Check restart recovery — if this PTY was spawned by a manual restart
      // and exited within 10 seconds, auto-recover with the previous CLI args
      const nodeId = stateManager.getNodeIdForSession(sessionId)
      const recovery = nodeId ? restartRecovery.get(nodeId) : undefined
      if (nodeId && recovery && recovery.newSessionId === sessionId) {
        const elapsed = Date.now() - recovery.restartedAt
        if (elapsed < 10_000 && !recovery.isRetry) {
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
              const recoveryClaudeId = findValidClaudeSession(recoveryHistory, recoveryCwd)
              const recoveryArgs = parseExtraCliArgs(recovery.previousExtraCliArgs)
              const recoveryOptions = { ...buildClaudeCodeCreateOptions(recoveryCwd, recoveryClaudeId, undefined, undefined, recoveryArgs), nodeId }
              const { sessionId: recoveryPtyId, cols: recoveryCols, rows: recoveryRows } = sessionManager.create(recoveryOptions)
              snapshotManager.addSession(recoveryPtyId, recoveryCols, recoveryRows)
              if (recoveryNode.shellTitleHistory?.length) {
                sessionManager.seedTitleHistory(recoveryPtyId, recoveryNode.shellTitleHistory)
              }
              stateManager.reincarnateTerminal(nodeId, recoveryPtyId, recoveryCols, recoveryRows)

              // Update recovery entry to mark as retry with the new session
              restartRecovery.set(nodeId, {
                restartedAt: Date.now(),
                newSessionId: recoveryPtyId,
                previousExtraCliArgs: recovery.previousExtraCliArgs,
                isRetry: true
              })

              // Notify clients
              broadcastToAll({
                type: 'server-error',
                message: `Terminal restarted with new CLI args exited after ${(elapsed / 1000).toFixed(1)}s (exit code ${exitCode}). Reverted to previous args and restarted.`
              })
              console.log(`[restart-recovery] Recovered node ${nodeId.slice(0, 8)} → session ${recoveryPtyId.slice(0, 8)}`)
            } catch (err: any) {
              console.error(`[restart-recovery] Failed to recover node ${nodeId.slice(0, 8)}: ${err.message}`)
              restartRecovery.delete(nodeId)
            }
          } else {
            restartRecovery.delete(nodeId)
          }

          broadcastToAttached(sessionId, { type: 'exit', sessionId, exitCode })
          broadcastToScriptSubscribers('exit', nodeId ?? undefined, { type: 'exit', nodeId, sessionId, exitCode })
          clients.forEach((client) => {
            client.attachedSessions.delete(sessionId)
            client.snapshotSessions.delete(sessionId)
          })
          return
        }
        // Retry already happened or elapsed >= 10s — clean up and proceed with normal exit
        restartRecovery.delete(nodeId)
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
      broadcastToScriptSubscribers('exit', nodeId ?? undefined, { type: 'exit', nodeId, sessionId, exitCode })
      // Remove from all clients' attached/snapshot sets
      clients.forEach((client) => {
        client.attachedSessions.delete(sessionId)
        client.snapshotSessions.delete(sessionId)
      })
    },
    // onTitleHistory: update state (node-updated broadcast handles client sync)
    (sessionId, history) => {
      stateManager.updateShellTitleHistory(sessionId, history)
    },
    // onCwd: update state (node-updated broadcast handles client sync)
    (sessionId, cwd) => {
      stateManager.updateCwd(sessionId, cwd)
    },
    // onClaudeSessionHistory: update state (node-updated broadcast handles client sync)
    (sessionId, history) => {
      stateManager.updateClaudeSessionHistory(sessionId, history)
    },
    // onClaudeState: update state + trigger auto-continue on API error stops
    (sessionId, state) => {
      stateManager.updateClaudeState(sessionId, state)
      if (state === 'stopped') {
        autoContinueManager.onStopped(sessionId)
      } else {
        // Any non-stopped state (e.g. working after user manually typed continue)
        // should cancel a pending auto-continue to avoid double-sending.
        autoContinueManager.cancelForSurface(sessionId)
      }
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
    },
    // onClaudeStatusAsleep: update state manager (node-updated broadcast handles client sync)
    (sessionId, asleep) => {
      stateManager.updateClaudeStatusAsleep(sessionId, asleep)
    },
    // onActivity: track last interaction timestamp for footer display
    (sessionId) => {
      stateManager.updateLastInteracted(sessionId, Date.now())
    }
  )

  // Initialize PlanCacheManager — caches plan file revisions for diffing
  planCacheManager = new PlanCacheManager()

  // Initialize SessionTitleSummarizer — generates 3-word titles from session transcripts
  sessionTitleSummarizer = new SessionTitleSummarizer({
    injectTitle: (sessionId, title) => sessionManager.injectTitle(sessionId, title),
  })

  // Initialize AutoContinueManager — auto-sends "continue" after API error stops
  autoContinueManager = new AutoContinueManager({
    getScrollback: (id) => sessionManager.getScrollback(id),
    writeToPty: (id, data) => sessionManager.write(id, data),
    getNodeTitle: (id) => {
      const nodeId = stateManager.getNodeIdForSession(id)
      if (!nodeId) return null
      const node = stateManager.getNode(nodeId)
      if (!node || node.type !== 'terminal') return null
      // Prefer user-set name, fall back to first shell title
      return node.name || node.shellTitleHistory?.[0] || null
    },
    broadcastToast: (message) => broadcastToAll({ type: 'server-error', message }),
  })

  // Initialize ClaudeStateMachine — manages state indicator transitions, queue, stale sweep
  claudeStateMachine = new ClaudeStateMachine({
    getClaudeState: (id) => sessionManager.getClaudeState(id),
    setClaudeState: (id, state) => sessionManager.setClaudeState(id, state),
    getClaudeStatusUnread: (id) => sessionManager.getClaudeStatusUnread(id),
    setClaudeStatusUnread: (id, unread) => sessionManager.setClaudeStatusUnread(id, unread),
    handleClaudeStop: (id) => sessionManager.handleClaudeStop(id),
    broadcastClaudeState: (id, state) => stateManager.updateClaudeState(id, state),
    broadcastClaudeStateDecisionTime: (id, ts) => stateManager.updateClaudeStateDecisionTime(id, ts),
    broadcastClaudeStatusUnread: (id, unread) => stateManager.updateClaudeStatusUnread(id, unread),
    setClaudeStatusAsleep: (id, asleep) => sessionManager.setClaudeStatusAsleep(id, asleep),
    broadcastClaudeStatusAsleep: (id, asleep) => stateManager.updateClaudeStatusAsleep(id, asleep),
  })

  // Initialize SessionFileWatcher — watches Claude session JSONL files for line count + plan cache + state routing
  sessionFileWatcher = new SessionFileWatcher((surfaceId, newEntries, totalLineCount, isBackfill) => {
    sessionManager.setClaudeSessionLineCount(surfaceId, totalLineCount)

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

  // --- Startup: reconcile with daemon sessions, then revive remaining terminals ---

  // Step 1: Ask daemon for all surviving sessions.
  const daemonSessions = await new Promise<Array<{ id: string; pid: number; cols: number; rows: number; alive: boolean; exitCode: number }>>((resolve) => {
    const handler = (msg: import('./daemon-client').DaemonMessage) => {
      if (msg.type === 'listed') {
        resolve(msg.sessions as Array<{ id: string; pid: number; cols: number; rows: number; alive: boolean; exitCode: number }>)
      }
    }
    // Temporarily intercept the next 'listed' response.
    const origHandler = daemonClient['onMessage']
    daemonClient['onMessage'] = (msg) => {
      if (msg.type === 'listed') {
        daemonClient['onMessage'] = origHandler
        handler(msg)
      } else {
        origHandler(msg)
      }
    }
    daemonClient.send({ type: 'list' })
  })
  const daemonSessionMap = new Map(daemonSessions.map(s => [s.id, s]))
  console.log(`[startup] Daemon has ${daemonSessions.length} session(s)`)

  // Step 2: Process dead terminals, but check daemon first.
  const deadTerminals = stateManager.processDeadTerminals()
  console.log(`[startup] ${deadTerminals.length} terminal(s) to process`)
  const revivedNodeIds: string[] = []
  const reattachedSessionIds = new Set<string>()

  for (const { nodeId, claudeSessionId, cwd, extraCliArgs } of deadTerminals) {
    // Check if this terminal's PTY is still alive in the daemon.
    const node = stateManager.getNode(nodeId)
    const ptySessionId = node?.type === 'terminal' ? node.sessionId : undefined
    const daemonSession = ptySessionId ? daemonSessionMap.get(ptySessionId) : undefined

    if (daemonSession && daemonSession.alive) {
      // PTY survived in daemon — re-attach instead of respawning.
      reattachedSessionIds.add(ptySessionId!)
      try {
        // Request attach — the daemon will send scrollback and start streaming output.
        const scrollback = await new Promise<string>((resolve) => {
          const origHandler = daemonClient['onMessage']
          daemonClient['onMessage'] = (msg) => {
            if (msg.type === 'attached' && msg.id === ptySessionId) {
              daemonClient['onMessage'] = origHandler
              resolve(msg.scrollback as string)
            } else {
              origHandler(msg)
            }
          }
          daemonClient.send({ type: 'attach', id: ptySessionId })
        })

        sessionManager.reattachSession(ptySessionId!, scrollback, daemonSession.cols, daemonSession.rows, cwd)
        snapshotManager.addSession(ptySessionId!, daemonSession.cols, daemonSession.rows)
        if (node?.type === 'terminal' && node.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(ptySessionId!, node.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(nodeId, ptySessionId!, daemonSession.cols, daemonSession.rows)

        // Re-watch Claude session file if applicable.
        if (claudeSessionId && cwd) {
          sessionFileWatcher.watch(ptySessionId!, claudeSessionId, cwd)
        }

        // Feed scrollback into snapshot manager for immediate snapshot availability.
        if (scrollback) {
          snapshotManager.write(ptySessionId!, scrollback)
        }

        console.log(`[startup] Re-attached to daemon session ${ptySessionId!.slice(0, 8)} for terminal ${nodeId.slice(0, 8)}`)
        continue
      } catch (err: any) {
        console.error(`[startup] Failed to re-attach to daemon session ${ptySessionId!.slice(0, 8)}: ${err.message}`)
        // Fall through to normal revival logic.
      }
    }

    // No surviving daemon session — use existing revival logic.
    if (claudeSessionId) {
      const history = (node?.type === 'terminal' && node.claudeSessionHistory) || []
      const validSessionId = findValidClaudeSession(history, cwd)

      if (!validSessionId) {
        console.log(`[startup] No valid Claude session JSONL found for terminal ${nodeId.slice(0, 8)}, archiving`)
        stateManager.archiveTerminal(nodeId)
        continue
      }
      if (validSessionId !== claudeSessionId) {
        console.log(`[startup] Session ${claudeSessionId.slice(0, 8)} has no JSONL, falling back to ${validSessionId.slice(0, 8)}`)
      }

      try {
        stateManager.markReviving(nodeId)
        const reviveOptions = { ...buildClaudeCodeCreateOptions(cwd, validSessionId, undefined, undefined, parseExtraCliArgs(extraCliArgs)), nodeId }
        const { sessionId, cols, rows } = sessionManager.create(reviveOptions)
        snapshotManager.addSession(sessionId, cols, rows)
        const revivingNode = stateManager.getNode(nodeId)
        if (revivingNode?.type === 'terminal' && revivingNode.shellTitleHistory?.length) {
          sessionManager.seedTitleHistory(sessionId, revivingNode.shellTitleHistory)
        }
        stateManager.reincarnateTerminal(nodeId, sessionId, cols, rows)
        const revivalCwd = sessionManager.getCwd(sessionId)
        if (revivalCwd) {
          sessionFileWatcher.watch(sessionId, validSessionId, revivalCwd)
        }
        revivedNodeIds.push(nodeId)
        console.log(`[startup] Revived terminal ${nodeId.slice(0, 8)} with Claude session ${validSessionId.slice(0, 8)}`)
      } catch (err: any) {
        stateManager.clearReviving(nodeId)
        console.error(`[startup] Failed to revive terminal ${nodeId.slice(0, 8)}: ${err.message}`)
        stateManager.archiveTerminal(nodeId)
      }
    } else {
      stateManager.archiveTerminal(nodeId)
      console.log(`[startup] Archived terminal ${nodeId.slice(0, 8)} (no Claude session)`)
    }
  }

  // Step 3: Destroy orphaned daemon sessions (in daemon but not in state).
  for (const daemonSess of daemonSessions) {
    if (!reattachedSessionIds.has(daemonSess.id) && daemonSess.alive) {
      console.log(`[startup] Destroying orphaned daemon session ${daemonSess.id.slice(0, 8)}`)
      daemonClient.send({ type: 'destroy', id: daemonSess.id })
    }
  }

  // After 30s, clear reviving flags — PTYs that survived this long are stable
  if (revivedNodeIds.length > 0) {
    setTimeout(() => {
      for (const nodeId of revivedNodeIds) {
        stateManager.clearReviving(nodeId)
      }
      console.log(`[startup] Cleared revival protection for ${revivedNodeIds.length} terminal(s)`)
    }, 30_000)
  }

  // --- Git status polling for directory nodes ---
  gitStatusPoller = new GitStatusPoller(
    () => stateManager.getDirectoryNodes(),
    (nodeId, gitStatus) => stateManager.updateDirectoryGitStatus(nodeId, gitStatus)
  )

  // --- Claude usage: load cached data and start polling ---
  loadCachedUsage()
  let usageLogDirReady = false
  setInterval(async () => {
    const now = Date.now()
    if (now - lastClientCommandAt > USAGE_IDLE_TIMEOUT_MS) return
    if (now - lastUsageFetchAt < USAGE_FETCH_COOLDOWN_MS) return
    lastUsageFetchAt = now
    try {
      const { usage, subscriptionType, rateLimitTier } = await fetchClaudeUsage()

      // Seed ring buffers from persisted log on first fetch
      const seedLog = path.join(USAGE_LOG_DIR, `usage_${subscriptionType}.jsonl`)
      creditHistory.seedFromLog(seedLog, 'extra_usage.used_credits')
      fiveHourHistory.seedFromLog(seedLog, 'five_hour.utilization')
      sevenDayHistory.seedFromLog(seedLog, 'seven_day.utilization')

      // Record values in the minute-keyed ring buffers
      const credits = usage.extra_usage?.used_credits ?? null
      if (credits != null) creditHistory.record(credits, now)
      if (usage.five_hour) fiveHourHistory.record(usage.five_hour.utilization, now)
      if (usage.seven_day) sevenDayHistory.record(usage.seven_day.utilization, now)

      broadcastToAll({ type: 'claude-usage', usage, subscriptionType, rateLimitTier, creditHistory: creditHistory.build(), fiveHourHistory: fiveHourHistory.build(), sevenDayHistory: sevenDayHistory.build() })
      saveCachedUsage(usage, subscriptionType, rateLimitTier)

      // Log usage data with flat dot-notation keys
      if (!usageLogDirReady) {
        fs.mkdirSync(USAGE_LOG_DIR, { recursive: true })
        usageLogDirReady = true
      }
      const logEntry: Record<string, string | number | boolean | null> = {
        timestamp: new Date(now).toISOString(),
      }
      if (usage.five_hour) logEntry['five_hour.utilization'] = usage.five_hour.utilization
      if (usage.seven_day) logEntry['seven_day.utilization'] = usage.seven_day.utilization
      if (usage.extra_usage) logEntry['extra_usage.used_credits'] = usage.extra_usage.used_credits
      const logFile = path.join(USAGE_LOG_DIR, `usage_${subscriptionType}.jsonl`)
      fs.appendFile(logFile, JSON.stringify(logEntry) + '\n', (err) => {
        if (err) console.error(`Failed to write usage log: ${err.message}`)
      })
    } catch (err: any) {
      console.error(`[claude-usage] Fetch failed: ${err.message}`)
    }
  }, USAGE_POLL_TICK_MS)

  // --- GitHub GraphQL rate limit polling ---
  loadCachedGhRateLimit()
  const pollGhRateLimit = async () => {
    const now = Date.now()
    try {
      const data = await fetchGhRateLimit()
      saveCachedGhRateLimit(data)
      ghRateLimitHistory.record(data.used, now)
      broadcastToAll({ type: 'gh-rate-limit', data, usedHistory: ghRateLimitHistory.build() })
      console.log(`[gh-rate-limit] ${data.used}/${data.limit}, resets ${data.resetAt}`)

      // Log to JSONL
      if (!usageLogDirReady) {
        fs.mkdirSync(USAGE_LOG_DIR, { recursive: true })
        usageLogDirReady = true
      }
      const logEntry = { timestamp: new Date(now).toISOString(), used: data.used, limit: data.limit, resetAt: data.resetAt }
      fs.appendFile(GH_RATE_LIMIT_LOG_FILE, JSON.stringify(logEntry) + '\n', (err) => {
        if (err) console.error(`[gh-rate-limit] Failed to write log: ${err.message}`)
      })
    } catch (err: any) {
      console.error(`[gh-rate-limit] Fetch failed: ${err.message}`)
    }
  }
  pollGhRateLimit() // initial fetch on startup
  setInterval(pollGhRateLimit, GH_RATE_LIMIT_POLL_MS)

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
      socket,
      attachedSessions: new Set(),
      snapshotSessions: new Set(),
      parser: new LineParser((msg) => {
        handleMessage(client, msg as ClientMessage)
      })
    }

    clients.add(client)
    console.log(`Client connected (${clients.size} total)`)

    // Send cached usage data immediately so the client doesn't wait for the next poll
    if (cachedUsage) {
      send(socket, {
        type: 'claude-usage',
        ...cachedUsage,
        creditHistory: creditHistory.build(),
        fiveHourHistory: fiveHourHistory.build(),
        sevenDayHistory: sevenDayHistory.build(),
      })
    }
    if (cachedGhRateLimit) {
      send(socket, { type: 'gh-rate-limit', data: cachedGhRateLimit, usedHistory: ghRateLimitHistory.build() })
    }

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

    socket.on('data', (data) => parser.feed(data as string))
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

    const parser = new LineParser((msg) => {
      handleScriptMessage(socket, msg as ScriptMessage)
    })

    socket.on('data', (data) => parser.feed(data as string))
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
  const shutdown = () => {
    console.log('\nShutting down...')
    if (socketWatchdog) clearInterval(socketWatchdog)
    // Flush queued transitions and stop timers before persisting state
    autoContinueManager.dispose()
    claudeStateMachine.dispose()
    gitStatusPoller.dispose()
    fileContentManager.dispose()
    sessionFileWatcher.dispose()
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
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

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
