import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { DataBatcher } from './data-batcher'
import { ScrollbackBuffer } from './scrollback-buffer'
import { getShellEnv } from './shell-integration'
import { TitleParser } from './title-parser'
import type { SessionInfo, CreateOptions, ClaudeSessionEntry } from '../shared/protocol'

const MAX_TITLE_HISTORY = 50
const MAX_CLAUDE_SESSION_HISTORY = 20

interface Session {
  id: string
  process: pty.IPty
  batcher: DataBatcher
  scrollback: ScrollbackBuffer
  titleParser: TitleParser
  shellTitleHistory: string[]
  claudeSessionHistory: ClaudeSessionEntry[]
  lastClaudeSessionId: string | null
  pendingStop: boolean
  waitingForUser: boolean
  cwd: string
  cols: number
  rows: number
}

export type DataCallback = (sessionId: string, data: string) => void
export type ExitCallback = (sessionId: string, exitCode: number) => void
export type TitleHistoryCallback = (sessionId: string, history: string[]) => void
export type CwdCallback = (sessionId: string, cwd: string) => void
export type ClaudeSessionHistoryCallback = (sessionId: string, history: ClaudeSessionEntry[]) => void
export type WaitingForUserCallback = (sessionId: string, waiting: boolean) => void

export class SessionManager {
  private sessions = new Map<string, Session>()
  private onData: DataCallback
  private onExit: ExitCallback
  private onTitleHistory: TitleHistoryCallback
  private onCwd: CwdCallback
  private onClaudeSessionHistory: ClaudeSessionHistoryCallback
  private onWaitingForUser: WaitingForUserCallback

  constructor(onData: DataCallback, onExit: ExitCallback, onTitleHistory: TitleHistoryCallback, onCwd: CwdCallback, onClaudeSessionHistory: ClaudeSessionHistoryCallback, onWaitingForUser: WaitingForUserCallback) {
    this.onData = onData
    this.onExit = onExit
    this.onTitleHistory = onTitleHistory
    this.onCwd = onCwd
    this.onClaudeSessionHistory = onClaudeSessionHistory
    this.onWaitingForUser = onWaitingForUser
  }

  create(options?: CreateOptions): SessionInfo {
    const sessionId = randomUUID()
    const cols = 160
    const rows = 45
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'
    const home = process.env.HOME || '/'

    // Resolve working directory: use options.cwd if it exists on disk, else $HOME
    const cwd = options?.cwd && existsSync(options.cwd) ? options.cwd : home

    const baseEnv = process.env as Record<string, string>
    const isCommand = !!options?.command
    const executable = isCommand ? options!.command! : shell
    const args = isCommand ? (options!.args || []) : []
    // Only apply shell integration env when spawning a shell (not a command)
    // Always copy env to avoid mutating process.env
    const env = isCommand ? { ...baseEnv } : getShellEnv(shell, baseEnv)
    env.SPACETERM_SURFACE_ID = sessionId

    const ptyProcess = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const scrollback = new ScrollbackBuffer()
    const shellTitleHistory: string[] = []

    const titleParser = new TitleParser(
      (title) => {
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

    ptyProcess.onData((data) => {
      titleParser.write(data)
      batcher.write(data)
    })

    ptyProcess.onExit(({ exitCode }) => {
      this.onExit(sessionId, exitCode)
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, {
      id: sessionId,
      process: ptyProcess,
      batcher,
      scrollback,
      titleParser,
      shellTitleHistory,
      claudeSessionHistory: [],
      lastClaudeSessionId: null,
      pendingStop: false,
      waitingForUser: false,
      cwd,
      cols,
      rows
    })

    return { sessionId, cols, rows }
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.process.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      try {
        session.process.resize(cols, rows)
        session.cols = cols
        session.rows = rows
      } catch {
        // Terminal may have already exited
      }
    }
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.batcher.dispose()
      session.process.kill()
      this.sessions.delete(sessionId)
    }
  }

  destroyAll(): void {
    const ids = Array.from(this.sessions.keys())
    ids.forEach((id) => this.destroy(id))
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

  setWaitingForUser(surfaceId: string, waiting: boolean): void {
    const session = this.sessions.get(surfaceId)
    if (!session || session.waitingForUser === waiting) return
    session.waitingForUser = waiting
    this.onWaitingForUser(surfaceId, waiting)
  }

  getWaitingForUser(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.waitingForUser ?? false
  }

  getClaudeSessionHistory(sessionId: string): ClaudeSessionEntry[] {
    const session = this.sessions.get(sessionId)
    return session ? session.claudeSessionHistory : []
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }
}
