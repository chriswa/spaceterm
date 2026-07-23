import { execFileSync } from 'child_process'

const SPACETERM_ENV_KEYS = [
  'SPACETERM_SURFACE_ID',
  'SPACETERM_NODE_ID',
  'SPACETERM_CLI',
  'SPACETERM_HOME',
] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Spaceterm surface/node ids are always `randomUUID()` values. */
export function isSpacetermUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** Reject empty / unresolved Cursor `${env:NAME}` literals. */
export function isUsableSpacetermEnvValue(value: string | undefined): value is string {
  if (!value) return false
  if (value.includes('${')) return false
  return true
}

function readProcessEnvMap(pid: number): Record<string, string> {
  // macOS `ps eww` appends the environment after the command line.
  const out = execFileSync('ps', ['eww', '-p', String(pid)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const parts = out.split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)
  const env: Record<string, string> = {}
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = part.slice(eq + 1)
  }
  return env
}

function parentPid(pid: number): number {
  const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const n = Number(out)
  return Number.isFinite(n) ? n : 0
}

/**
 * Cursor Agent CLI scrubs MCP stdio env and does not interpolate `${env:NAME}`
 * in plugin mcp.json — so SPACETERM_* never reaches this process. Walk ancestor
 * processes (the `agent` PTY has the real values) and copy them onto process.env.
 * No-ops when values are already present (Claude Code path).
 */
export function recoverSpacetermEnvFromAncestors(): void {
  if (isSpacetermUuid(process.env.SPACETERM_SURFACE_ID)) return

  let pid = process.ppid
  for (let i = 0; i < 12 && pid > 1; i++) {
    let env: Record<string, string>
    try {
      env = readProcessEnvMap(pid)
    } catch {
      break
    }
    for (const key of SPACETERM_ENV_KEYS) {
      const value = env[key]
      if (!isUsableSpacetermEnvValue(value)) continue
      if (key === 'SPACETERM_SURFACE_ID' || key === 'SPACETERM_NODE_ID') {
        if (!isSpacetermUuid(value)) continue
      }
      const existing = process.env[key]
      if (key === 'SPACETERM_SURFACE_ID' || key === 'SPACETERM_NODE_ID') {
        if (isSpacetermUuid(existing)) continue
      } else if (isUsableSpacetermEnvValue(existing)) {
        continue
      }
      process.env[key] = value
    }
    if (isSpacetermUuid(process.env.SPACETERM_SURFACE_ID)) {
      console.error(
        `[spaceterm-mcp] Recovered SPACETERM_SURFACE_ID from ancestor pid ${pid}`
      )
      return
    }
    try {
      pid = parentPid(pid)
    } catch {
      break
    }
  }
  console.error('[spaceterm-mcp] Could not recover SPACETERM_SURFACE_ID from ancestor processes')
}

/**
 * Returns the live PTY surface id, or throws if missing / not a UUID.
 * Non-UUID values (e.g. unresolved `${env:SPACETERM_SURFACE_ID}` literals) must
 * never be sent to the server — that produces silent no-ops.
 */
export function requireSurfaceId(): string {
  const surfaceId = process.env.SPACETERM_SURFACE_ID
  if (!surfaceId) {
    throw new Error(
      'SPACETERM_SURFACE_ID is not set. This tool only works inside a spaceterm terminal.',
    )
  }
  if (!isSpacetermUuid(surfaceId)) {
    throw new Error(
      `SPACETERM_SURFACE_ID must be a UUID, got ${JSON.stringify(surfaceId)}. ` +
        'Refusing to call spaceterm — a non-UUID surfaceId would be silently ignored by the server.',
    )
  }
  return surfaceId
}
