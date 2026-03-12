/**
 * API Usage Tracking — fetches authoritative month-to-date cost data for an
 * Anthropic API key by scraping the Platform Console's internal usage_cost
 * endpoint. Authenticates via Chrome's sessionKey cookie, decrypted from the
 * local Cookies SQLite database.
 *
 * Self-contained: .env reading, API key discovery, Chrome cookie decryption,
 * Platform API call, and cost calculation all live in this one file.
 *
 * The API key ID is resolved once (by listing workspace API keys and matching
 * by name prefix derived from the macOS full name) and then cached to disk so
 * subsequent polls skip the lookup entirely.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { SOCKET_DIR } from '../shared/protocol'
import type { ClaudeUsageResult } from './claude-usage'

// ---------------------------------------------------------------------------
// .env config (org + workspace only — API key ID is auto-discovered)
// ---------------------------------------------------------------------------

interface EnvConfig {
  orgId: string
  workspaceId: string
}

const ENV_PATH = path.resolve(__dirname, '..', '..', '.env')

function readEnvConfig(): EnvConfig | null {
  try {
    const text = fs.readFileSync(ENV_PATH, 'utf8')
    const vars: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/)
      if (match) vars[match[1]] = match[2]
    }
    const orgId = vars['ANTHROPIC_ORG_ID']
    const workspaceId = vars['ANTHROPIC_WORKSPACE_ID']
    if (!orgId || !workspaceId) return null
    return { orgId, workspaceId }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// API key ID discovery + caching
// ---------------------------------------------------------------------------

const API_KEY_CACHE_PATH = path.join(SOCKET_DIR, 'api-key-id-cache.json')

/** Reads cached API key IDs from disk, or null if missing/stale. */
function readCachedApiKeyIds(): string[] | null {
  try {
    const data = JSON.parse(fs.readFileSync(API_KEY_CACHE_PATH, 'utf8'))
    const ids = data?.apiKeyIds ?? (data?.apiKeyId ? [data.apiKeyId] : null)
    return Array.isArray(ids) && ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

function writeCachedApiKeyIds(apiKeyIds: string[]): void {
  fs.writeFile(API_KEY_CACHE_PATH, JSON.stringify({ apiKeyIds }), () => {})
}

interface ApiKeyEntry {
  id: string
  name: string
  status: string
  created_at: string
}

/**
 * Derives the dotted username from the macOS full name (e.g. "Chris Waddell" → "chris.waddell").
 * Falls back to the system $USER if `id -F` is unavailable.
 */
function deriveDottedUsername(): Promise<string> {
  return new Promise((resolve) => {
    execFile('id', ['-F'], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(process.env.USER ?? 'unknown')
        return
      }
      resolve(stdout.trim().toLowerCase().replace(/\s+/g, '.'))
    })
  })
}

/**
 * One-time API key discovery: lists workspace API keys via the Platform Console,
 * finds ALL active keys matching `claude_code_key_{username}_*`, and caches
 * their IDs to disk. Cost is summed across all matching keys.
 */
async function discoverApiKeyIds(env: EnvConfig, sessionKey: string, log: (msg: string) => void): Promise<string[]> {
  const username = await deriveDottedUsername()
  const prefix = `claude_code_key_${username}_`
  log(`[api-usage] Discovering API keys with prefix "${prefix}" (derived from macOS full name)`)

  const url = `https://platform.claude.com/api/console/organizations/${env.orgId}/workspaces/${env.workspaceId}/api_keys`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      headers: { Cookie: `sessionKey=${sessionKey}` },
      signal: controller.signal,
    })

    if (res.status === 403) throw new SessionExpiredError()
    if (!res.ok) throw new Error(`API keys list returned ${res.status}: ${await res.text()}`)

    const keys = (await res.json()) as ApiKeyEntry[]
    const matching = keys.filter(k => k.name.startsWith(prefix))

    if (matching.length === 0) {
      throw new Error(`No API keys found matching "${prefix}*" (${keys.length} keys in workspace)`)
    }

    for (const k of matching) {
      log(`[api-usage]   ${k.status.padEnd(8)} ${k.name} (${k.id})`)
    }
    log(`[api-usage] ${matching.length} keys matched, ${matching.filter(k => k.status === 'active').length} active`)

    const ids = matching.map(k => k.id)
    writeCachedApiKeyIds(ids)
    return ids
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Chrome cookie decryption
// ---------------------------------------------------------------------------

const CHROME_COOKIES_PATH = path.join(
  homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies',
)

/**
 * Thrown when the Platform API returns 403 (session expired / invalid).
 * The caller should clear the cached session key so the next poll re-decrypts.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('Platform session expired (403) — will re-decrypt Chrome cookie')
    this.name = 'SessionExpiredError'
  }
}

/** Module-level cache so we don't decrypt on every poll. Cleared on 403. */
let cachedSessionKey: string | null = null

function exec(cmd: string, args: string[], timeout = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout.trim())
    })
  })
}

async function getChromeSessionKey(log: (msg: string) => void): Promise<string | null> {
  // 1. Read Chrome Safe Storage password from Keychain
  let password: string
  try {
    password = await exec('security', [
      'find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome',
    ])
  } catch {
    log('[api-usage] Cannot read Chrome Safe Storage password from Keychain')
    return null
  }

  // 2. Copy Cookies DB (Chrome locks the original) and query via sqlite3 CLI
  if (!fs.existsSync(CHROME_COOKIES_PATH)) {
    log('[api-usage] Chrome Cookies database not found')
    return null
  }

  const tmpDb = path.join(SOCKET_DIR, '.chrome-cookies-tmp.db')
  try {
    fs.copyFileSync(CHROME_COOKIES_PATH, tmpDb)

    let hexValue: string
    try {
      hexValue = await exec('sqlite3', [
        tmpDb,
        "SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.platform.claude.com' AND name = 'sessionKey'",
      ])
    } finally {
      fs.unlink(tmpDb, () => {})
    }

    if (!hexValue) {
      log('[api-usage] No sessionKey cookie found for .platform.claude.com — log in to platform.claude.com in Chrome')
      return null
    }

    // 3. Derive AES key via PBKDF2
    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')

    // 4. Decrypt: strip 3-byte "v10" prefix, AES-128-CBC, IV = 16 spaces
    const enc = Buffer.from(hexValue, 'hex')
    const ciphertext = enc.subarray(3) // strip "v10"
    const iv = Buffer.alloc(16, 0x20)
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')

    // 5. Extract the session key token from the decrypted plaintext
    const match = plain.match(/sk-ant-sid\S+/)
    if (!match) {
      log('[api-usage] Decrypted cookie but could not extract sk-ant-sid token')
      return null
    }

    return match[0]
  } catch (err: any) {
    log(`[api-usage] Chrome cookie decryption failed: ${err.message}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Platform API — usage cost
// ---------------------------------------------------------------------------

interface UsageCostResponse {
  costs: Record<string, Array<{ key_id: string; total: number }>>
}

async function fetchUsageCost(env: EnvConfig, apiKeyIds: Set<string>, sessionKey: string): Promise<number> {
  const now = new Date()
  const startingOn = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`
  const tomorrow = new Date(now.getTime() + 86_400_000)
  const endingBefore = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`

  const url = `https://platform.claude.com/api/organizations/${env.orgId}/workspaces/${env.workspaceId}/usage_cost?starting_on=${startingOn}&ending_before=${endingBefore}&group_by=api_key_id`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      headers: { Cookie: `sessionKey=${sessionKey}` },
      signal: controller.signal,
    })

    if (res.status === 403) throw new SessionExpiredError()
    if (!res.ok) throw new Error(`Platform API returned ${res.status}: ${await res.text()}`)

    const data = (await res.json()) as UsageCostResponse
    let totalCents = 0
    for (const entries of Object.values(data.costs ?? {})) {
      for (const entry of entries) {
        if (apiKeyIds.has(entry.key_id)) totalCents += entry.total
      }
    }
    return totalCents
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Ensure session key is available (shared helper)
// ---------------------------------------------------------------------------

async function ensureSessionKey(log: (msg: string) => void): Promise<string> {
  if (!cachedSessionKey) {
    cachedSessionKey = await getChromeSessionKey(log)
    if (!cachedSessionKey) {
      throw new Error('Cannot read Chrome session cookie — log in to platform.claude.com in Chrome')
    }
  }
  return cachedSessionKey
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches the month-to-date cost (in cents) for ALL of the user's API keys
 * from Anthropic's Platform Console. Returns a ClaudeUsageResult compatible
 * with the existing usage pipeline.
 *
 * On first call, discovers matching API key IDs by listing workspace keys
 * and filtering by name prefix (derived from macOS full name). The IDs are
 * cached to ~/.spaceterm/api-key-id-cache.json so subsequent calls skip
 * the discovery step.
 *
 * Throws SessionExpiredError on 403 (caller should retry — cookie is auto-cleared).
 * Throws generic Error on other failures (caller should log and retry).
 */
export async function fetchApiUsage(log: (msg: string) => void): Promise<ClaudeUsageResult> {
  const env = readEnvConfig()
  if (!env) {
    throw new Error('Missing ANTHROPIC_ORG_ID / ANTHROPIC_WORKSPACE_ID in .env')
  }

  const sessionKey = await ensureSessionKey(log)

  // Resolve API key IDs: use cache, or discover once
  let apiKeyIds = readCachedApiKeyIds()
  if (!apiKeyIds) {
    try {
      apiKeyIds = await discoverApiKeyIds(env, sessionKey, log)
    } catch (err) {
      if (err instanceof SessionExpiredError) cachedSessionKey = null
      throw err
    }
  }

  try {
    const costCents = await fetchUsageCost(env, new Set(apiKeyIds), sessionKey)
    return {
      usage: {
        five_hour: null,
        seven_day: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        seven_day_cowork: null,
        extra_usage: {
          is_enabled: true,
          monthly_limit: null,
          used_credits: costCents,
          utilization: 0,
        },
      },
      subscriptionType: 'API',
      rateLimitTier: null,
    }
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      cachedSessionKey = null
    }
    throw err
  }
}
