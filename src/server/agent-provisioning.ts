import * as fs from 'fs'
import * as path from 'path'
import { homedir } from 'os'
import { SOCKET_DIR } from '../shared/protocol'
import { serverLog } from './server-log'
import type { AgentProvisioning } from './agent-drivers'

/**
 * Everything that has to exist on disk before an agent CLI can be launched:
 * plugin directories materialised under `~/.spaceterm`, hook handlers copied
 * and made executable, and entries merged into the user's own `~/.cursor` and
 * `~/.codex` config.
 *
 * Split out of index.ts because it is the half of agent support that a mod
 * cannot supply today. `AgentDriver` already lets a mod describe *how* to
 * launch an agent; `AgentProvisioning` is the interface for *what to install
 * first*, and this file is the first-party implementation of it. Keeping the
 * two apart is what MODDING.md's agent-mod pilot needs.
 *
 * Every merge here is deliberately additive: the user's own hooks and
 * statusLine are preserved, and a previous Spaceterm entry is replaced rather
 * than duplicated. Spaceterm does not own these files.
 */

/** Repository root, from which first-party plugin sources are copied. */
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

/** Cursor CLI hook events Spaceterm subscribes to via ~/.cursor/hooks.json. */
export const CURSOR_HOOK_EVENTS = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'stop',
  'sessionEnd',
  'subagentStart',
  'subagentStop',
] as const


/** Codex CLI hook events Spaceterm subscribes to via ~/.codex/hooks.json. */
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

export function isCodexHandlerCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && (
    cmd.includes('/.spaceterm/codex-agent-plugin/scripts/hook-handler.sh') ||
    cmd.includes('/src/codex-agent-plugin/scripts/hook-handler.sh')
  )
}

// ─── Config merges ──────────────────────────────────────────────────────────
//
// These three rewrite files the user owns. They are pure functions of the
// parsed document so the merge rules can be tested directly — this is the
// highest-stakes filesystem code in the repo, since getting a merge wrong
// silently damages a config Spaceterm did not create. The `ensure*` wrappers
// below are the thin read-parse-write shells around them.

/** True when a hook entry's command is one Spaceterm installed. */
function isCursorHandler(entry: unknown, handlerPath: string, script: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  const cmd = (entry as { command?: unknown }).command
  return typeof cmd === 'string' && (
    cmd === handlerPath ||
    cmd.includes(`/.spaceterm/cursor-agent-plugin/scripts/${script}`) ||
    cmd.includes(`/src/cursor-agent-plugin/scripts/${script}`)
  )
}

export interface CursorStatusLineMerge {
  /** The config to write back. */
  config: Record<string, unknown>
  /**
   * The user's previous statusLine, if it was not ours. Parked so our handler
   * can still run it, and so it survives outside Spaceterm.
   */
  passthrough?: unknown
}

/** Merge Spaceterm's statusLine into a parsed `~/.cursor/cli-config.json`. */
export function mergeCursorStatusLine(parsed: unknown, handlerPath: string): CursorStatusLineMerge {
  const config: Record<string, unknown> =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : { version: 1 }

  const previous = config.statusLine
  const passthrough =
    previous && !isCursorHandler(previous, handlerPath, 'statusline-handler.sh')
      ? previous
      : undefined

  config.statusLine = {
    type: 'command',
    command: handlerPath,
    // Match Claude-ish cadence without hammering hooks.sock
    updateIntervalMs: 1000,
  }
  if (typeof config.version !== 'number') config.version = 1

  return passthrough === undefined ? { config } : { config, passthrough }
}

/**
 * Merge Spaceterm's handler into a parsed `~/.cursor/hooks.json`.
 *
 * Additive: the user's own hooks for each event are preserved and ours is
 * appended, replacing a previous Spaceterm entry rather than duplicating it.
 */
export function mergeCursorHooks(parsed: unknown, handlerPath: string): Record<string, unknown> {
  const existing: { version?: unknown; hooks?: unknown } =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {}

  const hooks: Record<string, unknown[]> =
    existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
      ? { ...(existing.hooks as Record<string, unknown[]>) }
      : {}

  for (const event of CURSOR_HOOK_EVENTS) {
    const prev = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = prev.filter((e) => !isCursorHandler(e, handlerPath, 'hook-handler.sh'))
    kept.push({ command: handlerPath, timeout: 5 })
    hooks[event] = kept
  }

  return {
    ...existing,
    version: typeof existing.version === 'number' ? existing.version : 1,
    hooks,
  }
}

/**
 * Merge Spaceterm's handler into a parsed `~/.codex/hooks.json`.
 *
 * Codex nests hooks one level deeper than Cursor: each event holds matcher
 * *groups*, and a group holds hooks. A group is ours if any hook inside it is.
 */
export function mergeCodexHooks(parsed: unknown, handlerPath: string): Record<string, unknown> {
  const existing: { hooks?: unknown } =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {}

  const hooks: Record<string, unknown[]> =
    existing.hooks && typeof existing.hooks === 'object' && !Array.isArray(existing.hooks)
      ? { ...(existing.hooks as Record<string, unknown[]>) }
      : {}

  const groupHasOurs = (group: unknown): boolean => {
    if (!group || typeof group !== 'object') return false
    const inner = (group as { hooks?: unknown }).hooks
    if (!Array.isArray(inner)) return false
    return inner.some((h) => isCodexHandlerCommand((h as { command?: unknown })?.command))
  }

  for (const event of CODEX_HOOK_EVENTS) {
    const prev = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = prev.filter((g) => !groupHasOurs(g))
    // Codex clamps SessionEnd to 3s; use that so startup doesn't warn.
    const timeout = event === 'SessionEnd' ? 3 : 5
    kept.push({
      matcher: '*',
      hooks: [{ type: 'command', command: handlerPath, timeout }],
    })
    hooks[event] = kept
  }

  return { ...existing, hooks }
}

/** Read and parse a JSON file, or undefined when absent or unparseable. */
function readJson(filePath: string, tag: string): unknown {
  if (!fs.existsSync(filePath)) return undefined
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (err: any) {
    serverLog(`${tag} Failed to parse ${filePath}: ${err.message}; writing Spaceterm entries only`)
    return undefined
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n')
}

/**
 * Cursor CLI statusLine (Claude-compatible) is the continuous context % feed.
 * Merge Spaceterm's handler into ~/.cursor/cli-config.json. If the user already
 * had a custom statusLine, park it in ~/.spaceterm/cursor-statusline-passthrough.json
 * so our handler can still run it (and show it outside Spaceterm).
 */
export function ensureCursorStatusLine(handlerPath: string): void {
  const configPath = path.join(homedir(), '.cursor', 'cli-config.json')
  const passthroughPath = path.join(SOCKET_DIR, 'cursor-statusline-passthrough.json')

  const merged = mergeCursorStatusLine(readJson(configPath, '[cursor-statusline]'), handlerPath)
  if (merged.passthrough !== undefined) {
    writeJson(passthroughPath, { statusLine: merged.passthrough })
    serverLog(`[cursor-statusline] Preserved previous statusLine at ${passthroughPath}`)
  }
  writeJson(configPath, merged.config)
  serverLog(`[cursor-statusline] Merged Spaceterm statusLine into ${configPath}`)
}

/**
 * Cursor reads hooks from the workspace by default, which would mean writing
 * into the user's repo. Merge Spaceterm's handler into the user-global
 * ~/.cursor/hooks.json instead.
 */
export function ensureCursorUserHooks(handlerPath: string): void {
  const hooksPath = path.join(homedir(), '.cursor', 'hooks.json')
  writeJson(hooksPath, mergeCursorHooks(readJson(hooksPath, '[cursor-hooks]'), handlerPath))
  serverLog(`[cursor-hooks] Merged Spaceterm handler into ${hooksPath}`)
}

/**
 * Materialize the Cursor plugin under ~/.spaceterm (not the user's repo):
 * MCP via --plugin-dir, and sync the hook handler for ~/.cursor/hooks.json merge.
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

  // Keep plugin hooks.json as documentation/fallback; CLI does not execute these today.
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
  const mcpRunSh = path.join(PROJECT_ROOT, 'src/claude-code-plugin/mcp-server/run.sh')
  const mcpJson = {
    mcpServers: {
      spaceterm: {
        type: 'stdio',
        command: mcpRunSh,
        args: [] as string[],
      },
    },
  }
  fs.writeFileSync(path.join(destRoot, 'mcp.json'), JSON.stringify(mcpJson, null, 2) + '\n')

  ensureCursorUserHooks(handlerDest)
  ensureCursorStatusLine(statuslineDest)
  return destRoot
}

/** Latest Cursor chat id from session history (no on-disk JSONL validation). */
/** Launch Cursor Agent CLI with Spaceterm's plugin (MCP) + user-level hooks. */
/**
 * Merge Spaceterm's handler into user-global ~/.codex/hooks.json (Claude-shaped
 * event names, matcher groups).
 */
export function ensureCodexUserHooks(handlerPath: string): void {
  const hooksPath = path.join(homedir(), '.codex', 'hooks.json')
  writeJson(hooksPath, mergeCodexHooks(readJson(hooksPath, '[codex-hooks]'), handlerPath))
  serverLog(`[codex-hooks] Merged Spaceterm handler into ${hooksPath}`)
}

/**
 * Materialize Codex hook handler under ~/.spaceterm and sync user hooks +
 * Spaceterm-owned profile (MCP) under ~/.codex/.
 */
export function prepareCodexAgentDir(): string {
  const srcRoot = path.join(PROJECT_ROOT, 'src/codex-agent-plugin')
  const destRoot = path.join(SOCKET_DIR, 'codex-agent-plugin')
  const handlerSrc = path.join(srcRoot, 'scripts/hook-handler.sh')
  const handlerDest = path.join(destRoot, 'scripts/hook-handler.sh')

  fs.mkdirSync(path.join(destRoot, 'scripts'), { recursive: true })
  fs.copyFileSync(handlerSrc, handlerDest)
  fs.chmodSync(handlerDest, 0o755)

  ensureCodexUserHooks(handlerDest)

  // Spaceterm-owned profile layered via `-p spaceterm` — does not edit config.toml.
  const mcpRunSh = path.join(PROJECT_ROOT, 'src/claude-code-plugin/mcp-server/run.sh')
  const profilePath = path.join(homedir(), '.codex', 'spaceterm.config.toml')
  fs.mkdirSync(path.dirname(profilePath), { recursive: true })
  const profileBody = [
    '# Managed by Spaceterm — overwritten on each Codex surface launch.',
    '[mcp_servers.spaceterm]',
    `command = ${JSON.stringify(mcpRunSh)}`,
    'args = []',
    '',
  ].join('\n')
  fs.writeFileSync(profilePath, profileBody)
  serverLog(`[codex-mcp] Wrote Spaceterm profile ${profilePath}`)

  return destRoot
}

/**
 * First-party provisioning, as the driver registry consumes it.
 *
 * Claude needs none: its plugin directory is read straight out of the repo, and
 * its settings are passed on the command line rather than merged into a config
 * file.
 */
export const REAL_AGENT_PROVISIONING: AgentProvisioning = {
  claudePluginDir: () => path.join(PROJECT_ROOT, 'src/claude-code-plugin'),
  cursorPluginDir: prepareCursorAgentPluginDir,
  prepareCodex: prepareCodexAgentDir,
}
