import * as fs from 'fs'
import * as path from 'path'
import { SOCKET_DIR } from '../shared/protocol'
import type { AgentProvisioning } from './agent-drivers'

/**
 * Everything that has to exist on disk before an agent CLI can be launched:
 * plugin directories materialised under `~/.spaceterm`, and hook handlers
 * copied and made executable.
 *
 * Split out of index.ts because it is the half of agent support that a mod
 * cannot supply today. `AgentDriver` already lets a mod describe *how* to
 * launch an agent; `AgentProvisioning` is the interface for *what to install
 * first*, and this file is the first-party implementation of it. Keeping the
 * two apart is what MODDING.md's agent-mod pilot needs.
 *
 * Spaceterm does not write the user's own agent config. Every hook and MCP
 * server reaches the CLI per launch: Cursor's through `--plugin-dir` (plugin
 * hooks run since Cursor CLI 2026.08.11), Codex's as `-c` config overrides
 * (inline `[hooks]` since 0.124.0). Cursor's statusLine has no per-launch
 * mechanism at all, so it is left to the user to set up (README, "Cursor's
 * status line") and never touched here.
 */

/** Repository root, from which first-party plugin sources are copied. */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/** The MCP server every agent shares: the Claude plugin's stdio server. */
const MCP_RUN_SH = path.join(PROJECT_ROOT, 'src/claude-code-plugin/mcp-server/run.sh')

/** Cursor CLI hook events Spaceterm subscribes to via its plugin's hooks.json. */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'stop',
  'sessionEnd',
  'subagentStart',
  'subagentStop',
] as const


/** Codex CLI hook events Spaceterm subscribes to via `-c hooks.<event>=…`. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
] as const

// ─── Codex launch config ────────────────────────────────────────────────────

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
const tomlString = (s: string): string => JSON.stringify(s)

/**
 * The `-c key=value` overrides that give one Codex launch Spaceterm's hooks
 * and MCP server. Each value is parsed by Codex as TOML, and the overrides form
 * their own config layer: hooks from every layer run, so the user's own
 * `~/.codex/hooks.json` keeps working alongside these.
 */
export function codexConfigOverrides(handlerPath: string, mcpRunSh: string = MCP_RUN_SH): string[] {
  const hooks = CODEX_HOOK_EVENTS.map((event) => {
    // Codex clamps SessionEnd to 3s; use that so startup doesn't warn.
    const timeout = event === 'SessionEnd' ? 3 : 5
    return `hooks.${event}=[{matcher="*",hooks=[{type="command",command=${tomlString(handlerPath)},timeout=${timeout}}]}]`
  })
  return [
    ...hooks,
    `mcp_servers.spaceterm.command=${tomlString(mcpRunSh)}`,
    'mcp_servers.spaceterm.args=[]',
  ]
}

/**
 * Materialize the Cursor plugin under ~/.spaceterm (not the user's repo), for
 * `--plugin-dir`: its hooks and MCP server. The statusline handler is copied
 * too, for users who point `~/.cursor/cli-config.json` at it themselves.
 */
export function prepareCursorAgentPluginDir(): string {
  const srcRoot = path.join(PROJECT_ROOT, 'src/cursor-agent-plugin')
  const destRoot = path.join(SOCKET_DIR, 'cursor-agent-plugin')
  const handlerSrc = path.join(srcRoot, 'scripts/hook-handler.sh')
  const handlerDest = path.join(destRoot, 'scripts/hook-handler.sh')
  const statuslineSrc = path.join(srcRoot, 'scripts/statusline-handler.sh')
  const statuslineDest = path.join(destRoot, 'scripts/statusline-handler.sh')

  fs.mkdirSync(path.join(destRoot, '.cursor-plugin'), { recursive: true })
  fs.mkdirSync(path.join(destRoot, 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(destRoot, 'scripts'), { recursive: true })

  fs.copyFileSync(path.join(srcRoot, '.cursor-plugin/plugin.json'), path.join(destRoot, '.cursor-plugin/plugin.json'))
  fs.copyFileSync(handlerSrc, handlerDest)
  fs.chmodSync(handlerDest, 0o755)
  fs.copyFileSync(statuslineSrc, statuslineDest)
  fs.chmodSync(statuslineDest, 0o755)

  // Cursor CLI runs a --plugin-dir plugin's hooks/hooks.json since 2026.08.11.
  const hooks = {
    version: 1,
    hooks: Object.fromEntries(
      CURSOR_HOOK_EVENTS.map((event) => [event, [{ command: handlerDest, timeout: 5 }]])
    ),
  }
  fs.writeFileSync(path.join(destRoot, 'hooks/hooks.json'), JSON.stringify(hooks, null, 2) + '\n')

  // MCP: reuse Claude plugin's stdio server (absolute paths; no repo litter).
  // Do NOT put SPACETERM_* in mcp.json `env` / `${env:NAME}` here — Cursor Agent
  // CLI plugin path leaves `${env:…}` as literal strings (truthy), which breaks
  // tools. The MCP server recovers real IDs from ancestor process env at startup.
  const mcpJson = {
    mcpServers: {
      spaceterm: {
        type: 'stdio',
        command: MCP_RUN_SH,
        args: [] as string[],
      },
    },
  }
  fs.writeFileSync(path.join(destRoot, 'mcp.json'), JSON.stringify(mcpJson, null, 2) + '\n')

  return destRoot
}

/**
 * Materialize the Codex hook handler under ~/.spaceterm and return the `-c`
 * overrides that wire it, and the MCP server, into one launch.
 */
export function prepareCodexAgentDir(): string[] {
  const srcRoot = path.join(PROJECT_ROOT, 'src/codex-agent-plugin')
  const destRoot = path.join(SOCKET_DIR, 'codex-agent-plugin')
  const handlerSrc = path.join(srcRoot, 'scripts/hook-handler.sh')
  const handlerDest = path.join(destRoot, 'scripts/hook-handler.sh')

  fs.mkdirSync(path.join(destRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(handlerSrc, handlerDest)
  fs.chmodSync(handlerDest, 0o755)

  return codexConfigOverrides(handlerDest)
}

/**
 * First-party provisioning, as the driver registry consumes it.
 *
 * Claude needs none: its plugin directory is read straight out of the repo, and
 * its settings are passed on the command line.
 */
export const REAL_AGENT_PROVISIONING: AgentProvisioning = {
  claudePluginDir: () => path.join(PROJECT_ROOT, 'src/claude-code-plugin'),
  cursorPluginDir: prepareCursorAgentPluginDir,
  prepareCodex: prepareCodexAgentDir,
}
