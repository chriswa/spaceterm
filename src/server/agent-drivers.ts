import * as path from 'path'
import type { CreateOptions } from '../shared/protocol'
import { type AgentType, AGENT_LABELS, agentTypeOrDefault } from '../shared/agent-type'
import { expandTilde } from './cwd'

/**
 * How a surface is launched, in terms every agent can be asked about. Each
 * driver uses the fields that mean something to its CLI and ignores the rest —
 * that is the registry's contract, and the reason a caller no longer has to
 * know which agent it is talking to.
 */
export interface AgentLaunchSpec {
  cwd?: string
  prompt?: string
  /** Resume an existing conversation. */
  resumeSessionId?: string
  /** Branch from an existing conversation, leaving the original intact. */
  forkSessionId?: string
  /** Deliver `prompt` as an appended system prompt rather than a first turn. */
  appendSystemPrompt?: boolean
  /** From the surface's "Extra CLI arguments" control. */
  extraArgs?: string[]
}

/**
 * What the rest of the server is allowed to ask about an agent, instead of
 * testing its name. Every `agentType === 'cursor' || agentType === 'codex'`
 * in the codebase was really one of these questions.
 */
export interface AgentCapabilities {
  /** Writes Claude-shaped JSONL under ~/.claude/projects, so SessionFileWatcher can follow it. */
  claudeTranscript: boolean
  /**
   * Reviving an archived surface needs a resumable session id. Agents without
   * this can come back as a fresh conversation; Claude cannot, so a surface
   * with no valid session is re-archived rather than launched empty.
   */
  requiresResumableSession: boolean
  /**
   * How a conversation can be branched.
   *  - 'none'            not supported (Cursor)
   *  - 'native'          the CLI forks it itself, via `forkSessionId` (Codex)
   *  - 'transcript-clone' spaceterm clones the transcript and resumes the copy
   *                      (Claude)
   */
  forkStrategy: 'none' | 'native' | 'transcript-clone'
}

export interface AgentDriver {
  readonly type: AgentType
  readonly label: string
  readonly capabilities: AgentCapabilities
  /** Translate a launch spec into the command line for this agent's CLI. */
  buildCreateOptions(spec: AgentLaunchSpec): CreateOptions
}

/**
 * Filesystem provisioning each agent needs before it can be launched: plugin
 * directories, config merges, MCP profiles. Injected rather than imported so
 * the argv-building logic — which carries the permission-bypass flags and some
 * order-sensitive arguments — can be tested without touching the disk.
 */
export interface AgentProvisioning {
  /** Path to the Claude Code plugin directory. */
  claudePluginDir(): string
  /** Provision and return the Cursor plugin directory. */
  cursorPluginDir(): string
  /** Provision the Codex plugin directory and Spaceterm profile. */
  prepareCodex(): void
}

/** Escape a string for embedding inside a shell single-quoted string. */
export function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Tools withheld from every Claude surface. `--disallowed-tools` removes a tool
 * from the model's tool list outright rather than denying it at call time, so
 * the agent never sees it and cannot weigh it against an alternative.
 *
 * `EndConversation` ends the *chat* but leaves the CLI running, which on a
 * surface means a terminal sitting at a prompt with a dead conversation in it —
 * nothing an agent wanting to stop itself would choose on purpose. Ending a
 * surface is spaceterm's job, via a self-terminate MCP tool, and that one works
 * for Cursor and Codex too. Leaving both on offer only invites an agent to
 * reach for the inert one.
 */
const CLAUDE_WITHHELD_TOOLS = ['EndConversation']

function claudeDriver(provisioning: AgentProvisioning): AgentDriver {
  return {
    type: 'claude',
    label: AGENT_LABELS.claude,
    capabilities: {
      claudeTranscript: true,
      requiresResumableSession: true,
      forkStrategy: 'transcript-clone'
    },
    buildCreateOptions({ cwd, resumeSessionId, prompt, appendSystemPrompt, extraArgs }) {
      const pluginDir = provisioning.claudePluginDir()
      const statusLineSettings = JSON.stringify({
        statusLine: {
          type: 'command',
          command: path.join(pluginDir, 'scripts/statusline-handler.sh')
        }
      })
      const args = [
        '--plugin-dir', pluginDir,
        '--settings', statusLineSettings,
        // `--disallowed-tools` is variadic, so it has to be followed by another
        // flag — put it before `--dangerously-skip-permissions`, never last,
        // where it would swallow the leading entry of `extraArgs`.
        '--disallowed-tools', ...CLAUDE_WITHHELD_TOOLS,
        '--dangerously-skip-permissions'
      ]
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
  }
}

function cursorDriver(provisioning: AgentProvisioning): AgentDriver {
  return {
    type: 'cursor',
    label: AGENT_LABELS.cursor,
    capabilities: {
      claudeTranscript: false,
      requiresResumableSession: false,
      forkStrategy: 'none'
    },
    buildCreateOptions({ cwd, resumeSessionId, prompt, extraArgs }) {
      const pluginDir = provisioning.cursorPluginDir()
      // Expand `~` — Cursor takes the workspace as an argv entry, not a PTY cwd, so
      // no shell expansion happens and a literal `~` would fail to resolve.
      const resolvedCwd = expandTilde(cwd)
      const args = [
        '--plugin-dir', pluginDir,
        '--yolo',
        '--trust',
        '--approve-mcps',
      ]
      if (resolvedCwd) {
        args.push('--workspace', resolvedCwd)
      }
      if (extraArgs && extraArgs.length > 0) {
        args.push(...extraArgs)
      }
      if (resumeSessionId) {
        args.push(`--resume=${resumeSessionId}`)
      }
      if (prompt) {
        args.push(prompt)
      }
      return { cwd: resolvedCwd, command: 'agent', args }
    }
  }
}

function codexDriver(provisioning: AgentProvisioning): AgentDriver {
  return {
    type: 'codex',
    label: AGENT_LABELS.codex,
    capabilities: {
      claudeTranscript: false,
      requiresResumableSession: false,
      forkStrategy: 'native'
    },
    buildCreateOptions({ cwd, resumeSessionId, forkSessionId, prompt, extraArgs }) {
      provisioning.prepareCodex()
      // Expand `~` — Codex takes the working dir as an argv entry (`-C`), not a PTY
      // cwd, so no shell expansion happens and a literal `~` would fail to resolve.
      const resolvedCwd = expandTilde(cwd)
      const shared = [
        '--dangerously-bypass-hook-trust',
        '--dangerously-bypass-approvals-and-sandbox',
        // Spaceterm's MCP tools are few and surface-specific. Keep them in the
        // initial tool set so an agent can invoke them directly instead of first
        // discovering them through ToolSearch.
        '--disable', 'tool_search_always_defer_mcp_tools',
        '-p', 'spaceterm',
      ]
      if (resolvedCwd) {
        shared.push('-C', resolvedCwd)
      }
      if (extraArgs && extraArgs.length > 0) {
        // Insert after Spaceterm options so they remain OPTIONS before SESSION_ID/PROMPT.
        shared.push(...extraArgs)
      }

      let args: string[]
      if (forkSessionId) {
        // `codex fork [OPTIONS] [SESSION_ID] [PROMPT]`
        args = ['fork', ...shared, forkSessionId]
      } else if (resumeSessionId) {
        // `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`
        args = ['resume', ...shared, resumeSessionId]
      } else {
        args = [...shared]
      }
      if (prompt) {
        args.push(prompt)
      }
      return { cwd: resolvedCwd, command: 'codex', args }
    }
  }
}

/**
 * The registry. Adding an agent means adding an entry here, not editing six
 * spawn-dispatch sites, three label ternaries and a pair of capability checks.
 */
export function createAgentDrivers(provisioning: AgentProvisioning): Record<AgentType, AgentDriver> {
  return {
    claude: claudeDriver(provisioning),
    cursor: cursorDriver(provisioning),
    codex: codexDriver(provisioning)
  }
}

/**
 * Look up a driver, treating an absent agentType as Claude — surfaces created
 * before the field existed have none recorded.
 */
export function driverFor(
  drivers: Record<AgentType, AgentDriver>,
  agentType: AgentType | undefined
): AgentDriver {
  return drivers[agentTypeOrDefault(agentType)]
}
