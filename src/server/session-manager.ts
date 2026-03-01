import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { randomUUID } from 'crypto'
import { DataBatcher } from './data-batcher'
import { ScrollbackBuffer } from './scrollback-buffer'
import { getShellEnv } from './shell-integration'
import { TitleParser } from './title-parser'
import type { DaemonClient } from './daemon-client'
import type { SessionInfo, CreateOptions, ClaudeSessionEntry } from '../shared/protocol'
import type { ClaudeState } from '../shared/state'
import { DEFAULT_COLS, DEFAULT_ROWS } from '../shared/node-size'

const MAX_TITLE_HISTORY = 50
const MAX_CLAUDE_SESSION_HISTORY = 20

/** Titles that programs set spuriously (e.g. on every session revival) */
const SPURIOUS_TITLES = ['Claude Code']
function isSpuriousTitle(title: string): boolean {
  return SPURIOUS_TITLES.includes(title)
}

interface Session {
  id: string
  batcher: DataBatcher
  scrollback: ScrollbackBuffer
  titleParser: TitleParser
  shellTitleHistory: string[]
  claudeSessionHistory: ClaudeSessionEntry[]
  lastClaudeSessionId: string | null
  pendingStop: boolean
  claudeState: ClaudeState
  claudeStatusUnread: boolean
  claudeStatusAsleep: boolean
  claudeContextPercent: number | null
  claudeSessionLineCount: number | null
  cwd: string
  cols: number
  rows: number
}

export type DataCallback = (sessionId: string, data: string) => void
export type ExitCallback = (sessionId: string, exitCode: number) => void
export type TitleHistoryCallback = (sessionId: string, history: string[]) => void
export type CwdCallback = (sessionId: string, cwd: string) => void
export type ClaudeSessionHistoryCallback = (sessionId: string, history: ClaudeSessionEntry[]) => void
export type ClaudeStateCallback = (sessionId: string, state: ClaudeState) => void
export type ClaudeContextCallback = (sessionId: string, contextRemainingPercent: number) => void
export type ClaudeSessionLineCountCallback = (sessionId: string, lineCount: number) => void
export type ClaudeStatusUnreadCallback = (sessionId: string, unread: boolean) => void
export type ClaudeStatusAsleepCallback = (sessionId: string, asleep: boolean) => void
export type ActivityCallback = (sessionId: string) => void

export class SessionManager {
  private sessions = new Map<string, Session>()
  private daemon: DaemonClient
  private onData: DataCallback
  private onExit: ExitCallback
  private onTitleHistory: TitleHistoryCallback
  private onCwd: CwdCallback
  private onClaudeSessionHistory: ClaudeSessionHistoryCallback
  private onClaudeState: ClaudeStateCallback
  private onClaudeContext: ClaudeContextCallback
  private onClaudeSessionLineCount: ClaudeSessionLineCountCallback
  private onClaudeStatusUnread: ClaudeStatusUnreadCallback
  private onClaudeStatusAsleep: ClaudeStatusAsleepCallback
  private onActivity: ActivityCallback

  constructor(daemon: DaemonClient, onData: DataCallback, onExit: ExitCallback, onTitleHistory: TitleHistoryCallback, onCwd: CwdCallback, onClaudeSessionHistory: ClaudeSessionHistoryCallback, onClaudeState: ClaudeStateCallback, onClaudeContext: ClaudeContextCallback, onClaudeSessionLineCount: ClaudeSessionLineCountCallback, onClaudeStatusUnread: ClaudeStatusUnreadCallback, onClaudeStatusAsleep: ClaudeStatusAsleepCallback, onActivity: ActivityCallback) {
    this.daemon = daemon
    this.onData = onData
    this.onExit = onExit
    this.onTitleHistory = onTitleHistory
    this.onCwd = onCwd
    this.onClaudeSessionHistory = onClaudeSessionHistory
    this.onClaudeState = onClaudeState
    this.onClaudeContext = onClaudeContext
    this.onClaudeSessionLineCount = onClaudeSessionLineCount
    this.onClaudeStatusUnread = onClaudeStatusUnread
    this.onClaudeStatusAsleep = onClaudeStatusAsleep
    this.onActivity = onActivity
  }

  create(options?: CreateOptions): SessionInfo {
    const sessionId = randomUUID()
    const cols = DEFAULT_COLS
    const rows = DEFAULT_ROWS
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
    const home = process.env.HOME || '/'

    // Resolve working directory: expand ~ and use if it exists on disk, else $HOME
    let resolvedCwd = options?.cwd
    if (resolvedCwd?.startsWith('~')) {
      resolvedCwd = join(home, resolvedCwd.slice(1))
    }
    const cwd = resolvedCwd && existsSync(resolvedCwd) ? resolvedCwd : home

    const baseEnv = process.env as Record<string, string>
    const isCommand = !!options?.command
    const executable = isCommand ? options!.command! : shell
    const args = isCommand ? (options!.args || []) : ['-l']
    // Only apply shell integration env when spawning a shell (not a command)
    // Always copy env to avoid mutating process.env
    const env = isCommand ? { ...baseEnv } : getShellEnv(shell, baseEnv)
    env.SPACETERM_SURFACE_ID = sessionId
    // Stable node ID — survives reincarnation. Falls back to sessionId for initial creation.
    env.SPACETERM_NODE_ID = options?.nodeId ?? sessionId
    if (process.env.SPACETERM_HOME) {
      env.SPACETERM_HOME = process.env.SPACETERM_HOME
    }
    // CLI path for scripts to call spaceterm-cli commands
    const projectRoot = resolve(__dirname, '..', '..')
    env.SPACETERM_CLI = join(projectRoot, 'node_modules', '.bin', 'tsx') + ' ' + join(projectRoot, 'src', 'cli', 'spaceterm-cli.ts')
    // TERM must be explicit (the daemon does not inherit it from the server).
    env.TERM = 'xterm-256color'

    // Ask daemon to spawn the PTY.
    this.daemon.send({
      type: 'create',
      id: sessionId,
      command: executable,
      args,
      cwd,
      env,
      cols,
      rows,
    })

    // Set up local processing pipeline (TitleParser, DataBatcher, ScrollbackBuffer).
    this.initLocalSession(sessionId, cwd, cols, rows)

    return { sessionId, cols, rows }
  }

  /** Called by the daemon message router when PTY output arrives. */
  handleDaemonData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.titleParser.write(data)
    session.batcher.write(data)
    this.onActivity(sessionId)
  }

  /** Called by the daemon message router when a PTY exits. */
  handleDaemonExit(sessionId: string, exitCode: number): void {
    this.onExit(sessionId, exitCode)
    const session = this.sessions.get(sessionId)
    if (session) {
      session.batcher.dispose()
      this.sessions.delete(sessionId)
    }
  }

  /**
   * Re-attach to a daemon session that survived a server restart.
   * Replays the scrollback through the local pipeline to rebuild state.
   * Does NOT broadcast to clients — they get scrollback via the normal attach flow.
   */
  reattachSession(sessionId: string, scrollback: string, cols: number, rows: number, cwd?: string): void {
    this.initLocalSession(sessionId, cwd ?? process.env.HOME ?? '/', cols, rows)

    // Replay scrollback through TitleParser and ScrollbackBuffer only.
    // Skip DataBatcher to avoid broadcasting stale data to clients.
    if (scrollback) {
      const session = this.sessions.get(sessionId)!
      session.titleParser.write(scrollback)
      session.scrollback.write(scrollback)
    }
  }

  write(sessionId: string, data: string): void {
    if (!this.sessions.has(sessionId)) return
    this.daemon.send({ type: 'write', id: sessionId, data })
    this.onActivity(sessionId)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      this.daemon.send({ type: 'resize', id: sessionId, cols, rows })
      session.cols = cols
      session.rows = rows
    }
  }

  /** Destroy a session in the daemon (kills the PTY process). */
  destroy(sessionId: string): void {
    this.daemon.send({ type: 'destroy', id: sessionId })
    const session = this.sessions.get(sessionId)
    if (session) {
      session.batcher.dispose()
      this.sessions.delete(sessionId)
    }
  }

  /**
   * Clean up local session state only. Does NOT destroy PTYs in the daemon.
   * Called during server shutdown so sessions survive in the daemon.
   */
  destroyAll(): void {
    this.sessions.forEach((session) => session.batcher.dispose())
    this.sessions.clear()
  }

  list(): SessionInfo[] {
    const result: SessionInfo[] = []
    this.sessions.forEach((session) => {
      result.push({
        sessionId: session.id,
        cols: session.cols,
        rows: session.rows
      })
    })
    return result
  }

  getScrollback(sessionId: string): string | null {
    const session = this.sessions.get(sessionId)
    return session ? session.scrollback.getContents() : null
  }

  getShellTitleHistory(sessionId: string): string[] {
    const session = this.sessions.get(sessionId)
    return session ? session.shellTitleHistory : []
  }

  getCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd
  }

  handleClaudeSessionStart(surfaceId: string, claudeSessionId: string, source: string): void {
    const session = this.sessions.get(surfaceId)
    if (!session) return

    let reason: ClaudeSessionEntry['reason']
    if (source === 'resume' && session.pendingStop && session.lastClaudeSessionId !== null && session.lastClaudeSessionId !== claudeSessionId) {
      reason = 'fork'
    } else if (source === 'startup') {
      reason = 'startup'
    } else if (source === 'clear') {
      reason = 'clear'
    } else if (source === 'compact') {
      reason = 'compact'
    } else {
      reason = 'resume'
    }

    session.lastClaudeSessionId = claudeSessionId
    if (reason !== 'fork') session.pendingStop = false

    const entry: ClaudeSessionEntry = {
      claudeSessionId,
      reason,
      timestamp: new Date().toISOString()
    }

    session.claudeSessionHistory.push(entry)
    if (session.claudeSessionHistory.length > MAX_CLAUDE_SESSION_HISTORY) {
      session.claudeSessionHistory.shift()
    }

    this.onClaudeSessionHistory(surfaceId, session.claudeSessionHistory)
  }

  handleClaudeStop(surfaceId: string): void {
    const session = this.sessions.get(surfaceId)
    if (session) session.pendingStop = true
  }

  setClaudeState(surfaceId: string, state: ClaudeState): void {
    const session = this.sessions.get(surfaceId)
    if (!session || session.claudeState === state) return
    session.claudeState = state
    this.onClaudeState(surfaceId, state)
  }

  getClaudeState(sessionId: string): ClaudeState {
    return this.sessions.get(sessionId)?.claudeState ?? 'stopped'
  }

  setClaudeStatusUnread(surfaceId: string, unread: boolean): void {
    const session = this.sessions.get(surfaceId)
    if (!session || session.claudeStatusUnread === unread) return
    session.claudeStatusUnread = unread
    this.onClaudeStatusUnread(surfaceId, unread)
  }

  getClaudeStatusUnread(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.claudeStatusUnread ?? false
  }

  setClaudeStatusAsleep(surfaceId: string, asleep: boolean): void {
    const session = this.sessions.get(surfaceId)
    if (!session || session.claudeStatusAsleep === asleep) return
    session.claudeStatusAsleep = asleep
    this.onClaudeStatusAsleep(surfaceId, asleep)
  }

  getClaudeStatusAsleep(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.claudeStatusAsleep ?? false
  }

  setClaudeContextPercent(surfaceId: string, percent: number): void {
    const session = this.sessions.get(surfaceId)
    if (!session) return
    session.claudeContextPercent = percent
    this.onClaudeContext(surfaceId, percent)
  }

  getClaudeContextPercent(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.claudeContextPercent ?? null
  }

  setClaudeSessionLineCount(surfaceId: string, lineCount: number): void {
    const session = this.sessions.get(surfaceId)
    if (!session) return
    if (session.claudeSessionLineCount === lineCount) return
    session.claudeSessionLineCount = lineCount
    this.onClaudeSessionLineCount(surfaceId, lineCount)
  }

  getClaudeSessionLineCount(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.claudeSessionLineCount ?? null
  }

  getClaudeSessionHistory(sessionId: string): ClaudeSessionEntry[] {
    const session = this.sessions.get(sessionId)
    return session ? session.claudeSessionHistory : []
  }

  seedTitleHistory(sessionId: string, history: string[]): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const filtered = history.filter(t => !isSpuriousTitle(t))
    session.shellTitleHistory.push(...filtered)
  }

  /** Inject a title using the same LRU logic as the OSC title callback. */
  injectTitle(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (isSpuriousTitle(title)) return
    const { shellTitleHistory } = session
    const idx = shellTitleHistory.indexOf(title)
    if (idx !== -1) shellTitleHistory.splice(idx, 1)
    shellTitleHistory.unshift(title)
    if (shellTitleHistory.length > MAX_TITLE_HISTORY) {
      shellTitleHistory.pop()
    }
    this.onTitleHistory(sessionId, shellTitleHistory)
  }

  getLastClaudeSessionId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.lastClaudeSessionId ?? null
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  // --- Private helpers ---

  /** Create the local processing pipeline for a session (TitleParser, DataBatcher, ScrollbackBuffer). */
  private initLocalSession(sessionId: string, cwd: string, cols: number, rows: number): void {
    const scrollback = new ScrollbackBuffer()
    const shellTitleHistory: string[] = []

    const titleParser = new TitleParser(
      (title) => {
        if (isSpuriousTitle(title)) return
        const idx = shellTitleHistory.indexOf(title)
        if (idx !== -1) shellTitleHistory.splice(idx, 1)
        shellTitleHistory.unshift(title)
        if (shellTitleHistory.length > MAX_TITLE_HISTORY) {
          shellTitleHistory.pop()
        }
        this.onTitleHistory(sessionId, shellTitleHistory)
      },
      (newCwd) => {
        const session = this.sessions.get(sessionId)
        if (session) {
          session.cwd = newCwd
        }
        this.onCwd(sessionId, newCwd)
      }
    )

    const batcher = new DataBatcher((data) => {
      scrollback.write(data)
      this.onData(sessionId, data)
    })

    this.sessions.set(sessionId, {
      id: sessionId,
      batcher,
      scrollback,
      titleParser,
      shellTitleHistory,
      claudeSessionHistory: [],
      lastClaudeSessionId: null,
      pendingStop: false,
      claudeState: 'stopped' as ClaudeState,
      claudeStatusUnread: false,
      claudeStatusAsleep: false,
      claudeContextPercent: null,
      claudeSessionLineCount: null,
      cwd,
      cols,
      rows
    })
  }
}
