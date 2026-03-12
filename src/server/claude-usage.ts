import { execFile } from 'child_process'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'

/**
 * Thrown when the keychain has no OAuth credentials — i.e. the account is API-key
 * based rather than a Claude.ai subscription. The usage poller should stop permanently
 * on this error rather than retrying every tick.
 */
export class NoOAuthCredentialsError extends Error {
  constructor() {
    super('No Claude OAuth credentials in Keychain — account is API key type')
    this.name = 'NoOAuthCredentialsError'
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USER_AGENT = 'claude-code/2.1.47'
const TIMEOUT_MS = 5000

interface ClaudeOAuthCredentials {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    scopes: string[]
    subscriptionType: string | null
    rateLimitTier: string | null
  }
}

export interface UsageBucket {
  utilization: number
  resets_at: string
}

export interface ExtraUsage {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number
  utilization: number
}

export interface ClaudeUsageData {
  five_hour: UsageBucket | null
  seven_day: UsageBucket | null
  seven_day_opus: UsageBucket | null
  seven_day_sonnet: UsageBucket | null
  seven_day_cowork: UsageBucket | null
  extra_usage: ExtraUsage | null
}

function readKeychain(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', process.env.USER ?? 'unknown', '-w'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) return reject(new NoOAuthCredentialsError())
        const trimmed = stdout.trim()
        if (!trimmed) return reject(new Error('Empty Keychain entry'))
        resolve(trimmed)
      },
    )
  })
}

function parseCredentials(raw: string): ClaudeOAuthCredentials {
  const parsed = JSON.parse(raw)
  if (!parsed?.claudeAiOauth?.accessToken) {
    throw new Error('Keychain data missing claudeAiOauth.accessToken')
  }
  return parsed as ClaudeOAuthCredentials
}

export interface ClaudeUsageResult {
  usage: ClaudeUsageData
  subscriptionType: string | null
  rateLimitTier: string | null
}

export async function fetchClaudeUsage(): Promise<ClaudeUsageResult> {
  const raw = await readKeychain()
  const creds = parseCredentials(raw)
  const { accessToken, subscriptionType, rateLimitTier } = creds.claudeAiOauth

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    })

    if (!res.ok) {
      throw new Error(`Usage API returned ${res.status}: ${await res.text()}`)
    }

    const usage = (await res.json()) as ClaudeUsageData
    return { usage, subscriptionType, rateLimitTier }
  } finally {
    clearTimeout(timer)
  }
}
