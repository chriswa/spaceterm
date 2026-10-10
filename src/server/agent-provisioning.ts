import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SOCKET_DIR } from '../shared/protocol'
import { serverLog } from './server-log'
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
 * (inline `[hooks]` since 0.124.0). Earlier versions merged entries into
 * `~/.cursor/hooks.json`, `~/.codex/hooks.json` and `~/.cursor/cli-config.json`
 * and wrote `~/.codex/spaceterm.config.toml`; the `retire*` functions below
 * remove exactly those entries, once, so the hooks do not fire twice. Cursor's
 * statusLine has no per-launch mechanism at all, so it is left to the user to
 * set up (README, "Cursor's status line") and never touched here.
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

/**
 * Recognised by the plugin directory's name wherever it lives: `~/.spaceterm`,
 * the repo's `src/`, or a `SPACETERM_HOME` elsewhere — the e2e suite runs with
 * one under the system temp dir, and older versions merged those runs'
 * handlers into the real `~/.codex/hooks.json` too.
 */
export function isCodexHandlerCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes('/codex-agent-plugin/scripts/hook-handler.sh')
}

/** True when a hook entry's command is one Spaceterm installed (see above). */
function isCursorHandler(entry: unknown, handlerPath: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  const cmd = (entry as { command?: unknown }).command
  return typeof cmd === 'string' && (
    cmd === handlerPath || cmd.includes('/cursor-agent-plugin/scripts/hook-handler.sh')
  )
}

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

// ─── Retiring what older versions merged into the user's config ─────────────
//
// Pure functions of the parsed document, so the rules can be tested directly:
// this rewrites files Spaceterm does not own. Only Spaceterm's own entries are
// removed; an event left empty by that removal is dropped, and everything else
// survives as it was. `changed` is false when there was nothing of ours, so the
// file is not rewritten at all.

export interface Retired {
  config: unknown
  changed: boolean
}

/** Drop entries matching `ours` from every event in `parsed.hooks`. */
function withoutHooks(parsed: unknown, ours: (entry: unknown) => boolean): Retired {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { config: parsed, changed: false }
  const doc = parsed as Record<string, unknown>
  const hooks = doc.hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { config: parsed, changed: false }

  let changed = false
  const kept: Record<string, unknown> = {}
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) {
      kept[event] = entries
      continue
    }
    const remaining = entries.filter((e) => !ours(e))
    if (remaining.length === entries.length) {
      kept[event] = entries
      continue
    }
    changed = true
    if (remaining.length > 0) kept[event] = remaining
  }
  return changed ? { config: { ...doc, hooks: kept }, changed } : { config: parsed, changed }
}

/** `~/.cursor/hooks.json` without the handler older versions merged in. */
export function withoutCursorHooks(parsed: unknown, handlerPath: string): Retired {
  return withoutHooks(parsed, (e) => isCursorHandler(e, handlerPath))
}

/**
 * `~/.codex/hooks.json` without the matcher groups older versions merged in.
 * Codex nests hooks inside matcher groups; a group is ours if any hook in it is.
 */
export function withoutCodexHooks(parsed: unknown): Retired {
  return withoutHooks(parsed, (group) => {
    if (!group || typeof group !== 'object') return false
    const inner = (group as { hooks?: unknown }).hooks
    return Array.isArray(inner) && inner.some((h) => isCodexHandlerCommand((h as { command?: unknown })?.command))
  })
}

/** The first line of the profile older versions wrote to ~/.codex. */
export const CODEX_PROFILE_HEADER = '# Managed by Spaceterm'

/** Read and parse a JSON file, or undefined when absent or unparseable. */
function readJson(filePath: string, tag: string): unknown {
  if (!fs.existsSync(filePath)) return undefined
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err: any) {
    serverLog(`${tag} Failed to parse ${filePath}: ${err.message}; leaving it alone`)
    return undefined
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

/** Rewrite `filePath` without Spaceterm's entries, if it has any. */
function retireFromJson(filePath: string, tag: string, retire: (parsed: unknown) => Retired): void {
  const parsed = readJson(filePath, tag)
  if (parsed === undefined) return
  const { config, changed } = retire(parsed)
  if (!changed) return
  writeJson(filePath, config)
  serverLog(`${tag} Removed Spaceterm's entries from ${filePath}; its hooks now come with each launch`)
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

  retireFromJson(path.join(homedir(), '.cursor', 'hooks.json'), '[cursor-hooks]',
    (parsed) => withoutCursorHooks(parsed, handlerDest))
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

  retireFromJson(path.join(homedir(), '.codex', 'hooks.json'), '[codex-hooks]', withoutCodexHooks)
  retireCodexProfile(path.join(homedir(), '.codex', 'spaceterm.config.toml'))

  return codexConfigOverrides(handlerDest)
}

/** Delete the `-p spaceterm` profile older versions wrote, if it is still ours. */
function retireCodexProfile(profilePath: string): void {
  let body: string
  try {
    body = fs.readFileSync(profilePath, 'utf8')
  } catch {
    return
  }
  if (!body.startsWith(CODEX_PROFILE_HEADER)) return
  fs.rmSync(profilePath, { force: true })
  serverLog(`[codex-mcp] Removed ${profilePath}; the MCP server now comes with each launch`)
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
