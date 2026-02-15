#!/usr/bin/env tsx
/**
 * Emergency Terminal — CLI tool to list and connect to active spaceterm sessions.
 *
 * Usage:
 *   npm run et              # list active terminals
 *   npm run et -- 1         # connect to terminal #1
 *   npm run et -- abc1      # connect by ID prefix
 *
 * While connected:
 *   Ctrl+]  — detach (return to your shell)
 *
 * Connections run inside a tmux viewport sized to match the PTY exactly,
 * so output renders identically to the Electron client.
 */

import * as net from 'net'
import * as path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { SOCKET_PATH } from '../shared/protocol'
import type { ServerState, TerminalNodeData } from '../shared/state'

// ── Helpers ──────────────────────────────────────────────────────────

let seq = 0

interface ServerMsg {
  type: string
  seq?: number
  [key: string]: unknown
}

function sendMsg(socket: net.Socket, msg: Record<string, unknown>): void {
  socket.write(JSON.stringify(msg) + '\n')
}

/**
 * Connect to the spaceterm socket, send a message, wait for a reply of the given type.
 */
function oneshot(msg: Record<string, unknown>, replyType: string): Promise<ServerMsg> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH)
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
    socket.on('error', reject)
    socket.on('close', () => reject(new Error('Socket closed before reply')))

    sendMsg(socket, msg)
  })
}

/** Fetch server state and return only live terminal nodes. */
async function fetchLiveTerminals(): Promise<TerminalNodeData[]> {
  const reply = await oneshot({ type: 'node-sync-request', seq: ++seq }, 'sync-state')
  const state = reply.state as ServerState
  if (!state?.nodes) return []

  return Object.values(state.nodes).filter(
    (n): n is TerminalNodeData => n.type === 'terminal' && n.alive
  )
}

/** Resolve a user-provided target (index, ID prefix, or full ID) to a terminal. */
async function resolveTarget(target: string): Promise<TerminalNodeData> {
  let terminals: TerminalNodeData[]
  try {
    terminals = await fetchLiveTerminals()
  } catch {
    console.error('Failed to connect to spaceterm server.')
    console.error('Is the server running? (npm run server:dev)')
    process.exit(1)
  }

  if (terminals.length === 0) {
    console.error('No active terminals.')
    process.exit(1)
  }

  // Try as 1-based index
  if (/^\d+$/.test(target) && parseInt(target) <= terminals.length) {
    const idx = parseInt(target) - 1
    if (idx >= 0 && idx < terminals.length) {
      return terminals[idx]
    }
  }

  // Try as ID prefix
  const matches = terminals.filter((t) => t.sessionId.startsWith(target))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.error(`Ambiguous — multiple terminals match "${target}":`)
    for (const m of matches) {
      console.error(`  ${m.sessionId}  ${m.name || '(unnamed)'}`)
    }
    process.exit(1)
  }

  console.error(`No active terminal matching "${target}".`)
  process.exit(1)
}

// ── ANSI helpers ─────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const MAGENTA = '\x1b[35m'
const RED = '\x1b[31m'

// ── List command ─────────────────────────────────────────────────────

async function listTerminals(): Promise<void> {
  let terminals: TerminalNodeData[]
  try {
    terminals = await fetchLiveTerminals()
  } catch {
    console.error('Failed to connect to spaceterm server.')
    console.error('Is the server running? (npm run server:dev)')
    process.exit(1)
  }

  if (terminals.length === 0) {
    console.log('No active terminals.')
    return
  }

  console.log()
  console.log(`${BOLD}${CYAN} Emergency Terminal — ${terminals.length} active session${terminals.length !== 1 ? 's' : ''}${RESET}`)
  console.log()

  for (let i = 0; i < terminals.length; i++) {
    const t = terminals[i]
    const idx = `${DIM}[${i + 1}]${RESET}`
    const name = t.name ? `${BOLD}${t.name}${RESET}` : `${DIM}(unnamed)${RESET}`
    const sessionId = `${DIM}${t.sessionId}${RESET}`
    const cwd = t.cwd ? `${GREEN}${t.cwd}${RESET}` : `${DIM}—${RESET}`
    const claude =
      t.claudeState && t.claudeState !== 'stopped'
        ? ` ${MAGENTA}[claude: ${t.claudeState}]${RESET}`
        : ''
    const size = t.cols && t.rows ? `${DIM}${t.cols}x${t.rows}${RESET}` : ''

    console.log(`  ${idx} ${name}${claude}`)
    console.log(`      ${YELLOW}ID:${RESET}  ${sessionId}`)
    console.log(`      ${YELLOW}CWD:${RESET} ${cwd}  ${size}`)

    const titles = t.shellTitleHistory
    if (titles && titles.length > 0) {
      const recent = titles.slice(-5)
      console.log(`      ${YELLOW}Titles:${RESET}`)
      for (const title of recent) {
        console.log(`        ${DIM}· ${title}${RESET}`)
      }
    }
    console.log()
  }

  console.log(`${DIM}  Connect:  npm run et -- <number>${RESET}`)
  console.log(`${DIM}           npm run et -- <id-prefix>${RESET}`)
  console.log()
}

// ── Raw connect (runs inside tmux) ───────────────────────────────────

function rawConnect(sessionId: string): void {
  const socket = net.createConnection(SOCKET_PATH)
  socket.setEncoding('utf8')

  let buf = ''
  let attached = false
  const CTRL_CLOSE_BRACKET = 0x1d

  function onServerMessage(msg: ServerMsg): void {
    switch (msg.type) {
      case 'attached': {
        attached = true
        const scrollback = msg.scrollback as string
        if (scrollback) {
          process.stdout.write(scrollback)
        }
        break
      }
      case 'data': {
        if (msg.sessionId === sessionId) {
          process.stdout.write(msg.data as string)
        }
        break
      }
      case 'exit': {
        if (msg.sessionId === sessionId) {
          process.stderr.write(`\r\n${DIM}[Emergency Terminal] Session exited (code ${msg.exitCode}).${RESET}\r\n`)
          cleanup()
        }
        break
      }
    }
  }

  socket.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()!
    for (const line of lines) {
      if (!line) continue
      try {
        onServerMessage(JSON.parse(line) as ServerMsg)
      } catch { /* ignore */ }
    }
  })

  socket.on('error', (err) => {
    process.stderr.write(`\r\n${RED}[Emergency Terminal] Connection error: ${err.message}${RESET}\r\n`)
    cleanup()
  })

  socket.on('close', () => {
    if (attached) {
      process.stderr.write(`\r\n${DIM}[Emergency Terminal] Connection closed.${RESET}\r\n`)
    }
    cleanup()
  })

  // Attach — no resize, tmux viewport matches the PTY exactly
  sendMsg(socket, { type: 'attach', seq: ++seq, sessionId })

  // Enter raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()

  process.stdin.on('data', (data: Buffer) => {
    for (let i = 0; i < data.length; i++) {
      if (data[i] === CTRL_CLOSE_BRACKET) {
        process.stderr.write(`\r\n${DIM}[Emergency Terminal] Detached.${RESET}\r\n`)
        cleanup()
        return
      }
    }
    sendMsg(socket, { type: 'write', sessionId, data: data.toString() })
  })

  let cleanedUp = false
  function cleanup(): void {
    if (cleanedUp) return
    cleanedUp = true
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
    socket.destroy()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

// ── Connect via tmux viewport ────────────────────────────────────────

async function connectTerminal(target: string): Promise<void> {
  const resolved = await resolveTarget(target)
  const sessionId = resolved.sessionId
  const ptyCols = resolved.cols
  const ptyRows = resolved.rows
  const label = resolved.name || sessionId.slice(0, 8)

  // Check tmux is available
  try {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' })
  } catch {
    console.error(`${RED}tmux is required.${RESET} Install with: brew install tmux`)
    process.exit(1)
  }

  // Check local terminal can fit the tmux viewport (PTY size + 1 row for status bar)
  const localCols = process.stdout.columns || 80
  const localRows = process.stdout.rows || 24
  const neededRows = ptyRows + 1 // +1 for tmux status bar

  if (localCols < ptyCols || localRows < neededRows) {
    console.error(
      `${RED}${BOLD}Terminal too small.${RESET}\n` +
        `  Session needs: ${ptyCols}x${ptyRows} (+1 row for status = ${neededRows})\n` +
        `  Your terminal: ${localCols}x${localRows}\n` +
        `  Resize your window and retry.`
    )
    process.exit(1)
  }

  // Resolve paths for the tmux shell command
  const scriptPath = path.resolve(process.argv[1])
  const projectRoot = path.resolve(scriptPath, '..', '..', '..')
  const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx')
  const tmuxSession = `et-${sessionId.slice(0, 8)}`

  // Kill stale session with same name if it exists
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'pipe' })
  } catch { /* doesn't exist, fine */ }

  // Create detached tmux session sized to exactly match the PTY + status bar.
  // tmux reserves 1 row for the status bar, so pane size = ptyCols × ptyRows.
  const innerCmd = `"${tsxBin}" "${scriptPath}" --raw ${sessionId}`
  execFileSync('tmux', [
    'new-session', '-d',
    '-s', tmuxSession,
    '-x', String(ptyCols),
    '-y', String(neededRows),
    innerCmd
  ])

  // Configure tmux status bar
  const tmuxSet = (option: string, value: string): void => {
    execFileSync('tmux', ['set-option', '-t', tmuxSession, option, value])
  }
  tmuxSet('status', 'on')
  tmuxSet('status-position', 'bottom')
  tmuxSet('status-style', 'bg=#1e1e2e,fg=#7f849c')
  tmuxSet('status-left', ` Emergency Terminal │ ${label} │ Ctrl+] to detach `)
  tmuxSet('status-left-length', '120')
  tmuxSet('status-right', '')
  tmuxSet('status-right-length', '0')

  // Attach — blocks until the inner process exits or user detaches with Ctrl+B D
  spawnSync('tmux', ['attach-session', '-t', tmuxSession], { stdio: 'inherit' })
}

// ── Main ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args[0] === '--raw' && args[1]) {
  // Inner mode: raw pipe connection (called by tmux, not by the user)
  rawConnect(args[1])
} else if (!args[0] || args[0] === '--list' || args[0] === '-l') {
  listTerminals().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
} else if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
${BOLD}Emergency Terminal${RESET} — connect to active spaceterm sessions from the CLI.

${YELLOW}Usage:${RESET}
  npm run et              List active terminals
  npm run et -- <id>      Connect by session ID (prefix match)
  npm run et -- <n>       Connect by index number from list

${YELLOW}While connected:${RESET}
  Ctrl+]    Detach and return to your shell
  Ctrl+B D  Detach (tmux-style, session stays alive for re-attach)

${YELLOW}Re-attach to a detached session:${RESET}
  tmux attach -t et-<id-prefix>
`)
} else {
  connectTerminal(args[0]).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
