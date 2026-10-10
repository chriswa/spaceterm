import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SOCKET_DIR } from '../shared/protocol'
import { CLAUDE_PRINT_BIN } from './claude-print'

/**
 * What optional integrations are available on this machine, and what degrades
 * without each one.
 *
 * Several features are best-effort by design: Summary Chat needs
 * claude-print-daemon and a running Voice Operator, and
 * background-work reconciliation needs `pgrep`. Each already fails softly —
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

export function probeCapabilities(deps: CapabilityDeps = REAL_CAPABILITY_DEPS): Capability[] {
  const capabilities: Capability[] = []

  // Control, Summary Chat and auto-stamps reach Claude through claude-print-daemon,
  // which runs the signed-in Claude Code. The binary is enough: it starts the
  // daemon itself.
  const claudePrint = deps.which(CLAUDE_PRINT_BIN)
  capabilities.push({
    id: 'claude-print-daemon',
    name: 'claude-print-daemon',
    available: claudePrint !== undefined,
    detail: claudePrint ?? `${CLAUDE_PRINT_BIN} not found on PATH (build it with go build and put it on PATH, or set CLAUDE_PRINT_DAEMON_BIN)`,
    affects: claudePrint ? '' : 'Control and Summary Chat cannot reach Claude and report an error on every turn; auto-stamp icons all fail'
  })

  const voice = deps.exists(VOICE_OPERATOR_DISCOVERY)
  capabilities.push({
    id: 'voice-operator',
    name: 'Voice Operator speech service',
    available: voice,
    detail: voice ? `discovery file at ${VOICE_OPERATOR_DISCOVERY}` : 'not running (macOS only)',
    affects: voice ? '' : 'Summary Chat produces text but nothing is spoken'
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
 * Written at startup so the answer to "why is Summary Chat doing nothing?" is
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
