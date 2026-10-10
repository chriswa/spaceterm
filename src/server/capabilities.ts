import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SOCKET_DIR } from '../shared/protocol'
import { CLAUDE_PRINT_BIN } from './claude-print'
import { DAEMON_BIN } from './daemon-client'
import { APP_CANDIDATES as AI_SPEND_CANDIDATES } from './usage-tracker'
import { AGENT_PTY_COMMANDS } from '../shared/agent-type'

/**
 * What optional integrations are available on this machine, and what degrades
 * without each one.
 *
 * Several features are best-effort by design: Control needs
 * claude-print-daemon and a running Voice Operator, agent search needs `jev`,
 * and background-work reconciliation needs `pgrep`. Each agent surface type
 * needs its CLI. Each already fails softly —
 * which is right, but means a user on a machine without them sees a feature
 * that quietly does nothing and no indication why.
 *
 * Probing once at startup and writing the result to the log turns "silently
 * broken" into "here is what is missing and what it costs you", which is the
 * difference between a tool that works on the author's laptop and one someone
 * else can adopt.
 */

export interface Capability {
  /** Stable identifier, for log greps and future protocol exposure. */
  readonly id: string
  /** What is being looked for. */
  readonly name: string
  readonly available: boolean
  /** What was found, or why the probe failed. */
  readonly detail: string
  /** What stops working without it. Empty when available. */
  readonly affects: string
}

export interface CapabilityDeps {
  /** The executable `command` resolves to on PATH, or undefined. */
  which(command: string): string | undefined
  /** True when a path exists and is executable. */
  isExecutable(filePath: string): boolean
  /** True when a path exists. */
  exists(filePath: string): boolean
}

export const REAL_CAPABILITY_DEPS: CapabilityDeps = {
  which(command) {
    const candidates = command.includes('/')
      ? [command]
      : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command))
    return candidates.find(candidate => REAL_CAPABILITY_DEPS.isExecutable(candidate))
  },
  isExecutable(filePath) {
    try {
      fs.accessSync(filePath, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  exists: (filePath) => fs.existsSync(filePath),
}

/**
 * Absolute paths the background-work prober shells out to. Hardcoded there as
 * well; probed here so a machine without them says so rather than silently
 * never draining a surface back to idle.
 */
const PGREP_PATH = '/usr/bin/pgrep'
const LSOF_PATH = '/usr/sbin/lsof'

/** Where Voice Operator advertises its port, if it is running. */
const VOICE_OPERATOR_DISCOVERY = path.join(
  homedir(), 'Library', 'Application Support', 'VoiceOperator', 'speech-service.json'
)

/** What each agent surface type is called, for saying what a missing CLI costs. */
const AGENT_SURFACE_NAMES: Record<keyof typeof AGENT_PTY_COMMANDS, string> = {
  claude: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
}

export function probeCapabilities(
  deps: CapabilityDeps = REAL_CAPABILITY_DEPS,
  env: Readonly<Record<string, string | undefined>> = process.env
): Capability[] {
  const capabilities: Capability[] = []

  // The PTY daemon is built from source (Go), not installed by npm, so a fresh
  // clone has none until `npm run daemon:build`.
  const daemonBin = deps.isExecutable(DAEMON_BIN)
  capabilities.push({
    id: 'pty-daemon-binary',
    name: 'PTY daemon binary',
    available: daemonBin,
    detail: daemonBin ? DAEMON_BIN : `${DAEMON_BIN} not built (run npm run daemon:build; needs Go)`,
    affects: daemonBin ? '' : 'no terminal can start'
  })

  // Looked up on this process's PATH. A surface resolves its CLI on the login
  // shell's PATH instead (command-path.ts), so run this from a terminal for
  // the answer a surface would get.
  for (const [type, command] of Object.entries(AGENT_PTY_COMMANDS) as [keyof typeof AGENT_PTY_COMMANDS, string][]) {
    const found = deps.which(command)
    const name = AGENT_SURFACE_NAMES[type]
    capabilities.push({
      id: `agent-${type}`,
      name: `${name} CLI (${command})`,
      available: found !== undefined,
      detail: found ?? `${command} not found on PATH`,
      affects: found ? '' : `${name} surfaces cannot start`
    })
  }

  const git = deps.which('git')
  capabilities.push({
    id: 'git',
    name: 'git',
    available: git !== undefined,
    detail: git ?? 'git not found on PATH (xcode-select --install)',
    affects: git ? '' : 'no git status on the canvas'
  })

  // Control and auto-stamps reach Claude through claude-print-daemon,
  // which runs the signed-in Claude Code. The binary is enough: it starts the
  // daemon itself.
  const claudePrint = deps.which(CLAUDE_PRINT_BIN)
  capabilities.push({
    id: 'claude-print-daemon',
    name: 'claude-print-daemon',
    available: claudePrint !== undefined,
    detail: claudePrint ?? `${CLAUDE_PRINT_BIN} not found on PATH (chriswa-devkit tools/claude-print-daemon; build it into bin/ with go build, or set CLAUDE_PRINT_DAEMON_BIN)`,
    affects: claudePrint ? '' : 'Control cannot reach Claude and reports an error on every turn; auto-stamp icons all fail'
  })

  // jev also needs TYPESAFE_API_KEY, which it reads from the login shell's
  // environment; only its presence is checked here.
  const jev = deps.which('jev')
  capabilities.push({
    id: 'jev',
    name: 'jev',
    available: jev !== undefined,
    detail: jev ?? 'jev not found on PATH (chriswa-devkit tools/jev; needs Bun and TYPESAFE_API_KEY)',
    affects: jev ? '' : 'agent search fails; Control cannot judge interruptions or its backlog'
  })

  const voice = deps.exists(VOICE_OPERATOR_DISCOVERY)
  capabilities.push({
    id: 'voice-operator',
    name: 'Voice Operator speech service',
    available: voice,
    detail: voice ? `discovery file at ${VOICE_OPERATOR_DISCOVERY}` : 'not running (macOS only)',
    affects: voice ? '' : 'nothing is spoken on the Mac: Control and the speak-the-selection chord are silent there'
  })

  // Presence, not exit code: pgrep exits 1 when nothing matches, so running it
  // as a probe reports a perfectly good pgrep as missing. A diagnostic that
  // cries wolf is worse than none.
  const pgrep = deps.isExecutable(PGREP_PATH)
  capabilities.push({
    id: 'pgrep',
    name: 'pgrep',
    available: pgrep,
    detail: pgrep ? `${PGREP_PATH} is executable` : `${PGREP_PATH} not found or not executable`,
    affects: pgrep ? '' : 'a surface stuck on background work may not drain back to idle on its own'
  })

  const lsof = deps.isExecutable(LSOF_PATH)
  capabilities.push({
    id: 'lsof',
    name: 'lsof',
    available: lsof,
    detail: lsof ? `${LSOF_PATH} is executable` : `${LSOF_PATH} not found or not executable`,
    affects: lsof ? '' : 'background shell commands cannot be detected as finished by their output file'
  })

  // Running, it is found wherever it lives (usage-tracker.ts asks pgrep); this
  // checks only where it is looked for when it is not.
  const spend = env.SPACETERM_AI_SPEND ?? AI_SPEND_CANDIDATES.find((p) => deps.isExecutable(p))
  capabilities.push({
    id: 'ai-spend-tracker',
    name: 'AI Spend Tracker',
    available: spend !== undefined,
    detail: spend ?? 'not installed at a known path (github.com/chriswa/ai-spend-tracker; fine if it is running from elsewhere)',
    affects: spend ? '' : 'the phone\'s usage bars stay empty unless the app is running'
  })

  const daemon = deps.exists(path.join(SOCKET_DIR, 'pty-daemon.sock'))
  capabilities.push({
    id: 'pty-daemon',
    name: 'PTY daemon socket',
    available: daemon,
    detail: daemon ? 'socket present' : 'not yet started — normal on a cold boot',
    affects: daemon ? '' : 'terminals cannot start until the daemon comes up'
  })

  return capabilities
}

/**
 * One log line per capability, plus a summary.
 *
 * Written at startup so the answer to "why is Control doing nothing?" is
 * already in `~/.spaceterm/` rather than requiring a bug report.
 */
export function formatCapabilityReport(capabilities: Capability[]): string[] {
  const lines = capabilities.map((c) =>
    c.available
      ? `[capabilities] ✓ ${c.name} — ${c.detail}`
      : `[capabilities] ✗ ${c.name} — ${c.detail}; ${c.affects}`
  )
  const missing = capabilities.filter((c) => !c.available)
  lines.push(
    missing.length === 0
      ? '[capabilities] all optional integrations available'
      : `[capabilities] ${missing.length} of ${capabilities.length} unavailable: ${missing.map((c) => c.id).join(', ')}`
  )
  return lines
}
