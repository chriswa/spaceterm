import * as pty from 'node-pty'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { DataBatcher } from './data-batcher'
import { ScrollbackBuffer } from './scrollback-buffer'
import { getShellEnv } from './shell-integration'
import type { SessionInfo, CreateOptions } from '../shared/protocol'

interface Session {
  id: string
  process: pty.IPty
  batcher: DataBatcher
  scrollback: ScrollbackBuffer
  cols: number
  rows: number
}

export type DataCallback = (sessionId: string, data: string) => void
export type ExitCallback = (sessionId: string, exitCode: number) => void

export class SessionManager {
  private sessions = new Map<string, Session>()
  private onData: DataCallback
  private onExit: ExitCallback

  constructor(onData: DataCallback, onExit: ExitCallback) {
    this.onData = onData
    this.onExit = onExit
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
    const env = isCommand ? baseEnv : getShellEnv(shell, baseEnv)

    const ptyProcess = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })

    const scrollback = new ScrollbackBuffer()

    const batcher = new DataBatcher((data) => {
      scrollback.write(data)
      this.onData(sessionId, data)
    })

    ptyProcess.onData((data) => {
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

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }
}
