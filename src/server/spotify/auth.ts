import { createHash, randomBytes } from 'crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'

/**
 * Signing in to Spotify's Web API, and staying signed in.
 *
 * The flow is Authorization Code with PKCE, which needs no client secret: the
 * one-off sign-in is `npm run spotify -- login` (src/cli/spotify.ts), which
 * writes the tokens to `~/.spaceterm/spotify.json`. The server reads that file
 * whenever it needs a token, so signing in again needs no restart.
 *
 * The tokens live in a file, mode 0600, beside the APNs key and the web
 * token, rather than in 1Password: Spotify hands out a new refresh token on
 * most refreshes, about once an hour of use, and the server would have to
 * write each one back through `op`, which asks for Touch ID from a server
 * nobody is watching. The client ID is not a secret in PKCE.
 *
 * Checked against Spotify in November 2026: the redirect must be a loopback
 * IP literal (`localhost` is refused) or HTTPS, and must match the one
 * registered in the app's settings exactly.
 */

export const TOKEN_URL = 'https://accounts.spotify.com/api/token'
export const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize'
/** Registered in the Spotify app's settings. No dash in the path: the dashboard has been reported to call those insecure. */
export const REDIRECT_PORT = 47791
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`
/**
 * What the sign-in asks for. Adding a scope later (playlists, say) means
 * signing in again; the tokens record what was granted, so a command can
 * say which scope it lacks.
 */
export const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'user-read-recently-played', 'playlist-read-private', 'playlist-read-collaborative',
]

export const TOKEN_FILE = join(SOCKET_DIR, 'spotify.json')
/** Where the user pastes the client ID during setup; sign-in moves it into TOKEN_FILE and deletes this. */
export const CLIENT_ID_DROP_FILE = join(SOCKET_DIR, 'spotify-client-id.txt')

export interface SpotifyTokens {
  clientId: string
  refreshToken: string
  accessToken: string
  /** Epoch ms. */
  expiresAt: number
  /** Space-separated, as granted. */
  scope: string
}

export interface TokenStore {
  read(): SpotifyTokens | undefined
  write(tokens: SpotifyTokens): void
}

export function fileTokenStore(path = TOKEN_FILE): TokenStore {
  return {
    read() {
      if (!existsSync(path)) return undefined
      return JSON.parse(readFileSync(path, 'utf8')) as SpotifyTokens
    },
    write(tokens) {
      // Whole or not at all: a half-written file would lose the only refresh token.
      const temp = `${path}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 })
      chmodSync(temp, 0o600)
      renameSync(temp, path)
    },
  }
}

/** A Spotify app's client ID: 32 hex digits. */
export function isClientId(text: string): boolean {
  return /^[0-9a-f]{32}$/i.test(text)
}

export interface Pkce {
  verifier: string
  challenge: string
}

export function makePkce(): Pkce {
  const verifier = randomBytes(64).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function authorizeUrl(clientId: string, pkce: Pkce, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge_method: 'S256',
    code_challenge: pkce.challenge,
  })
  return `${AUTHORIZE_URL}?${params}`
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

/** Thrown when Spotify will not refresh, so only signing in again helps. */
export class SignInNeeded extends Error {}

/** POST to the token endpoint. Rejects with Spotify's own reason. */
async function postToken(fetchFn: typeof fetch, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const text = await res.text()
  if (!res.ok) {
    let reason = text
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string }
      reason = [j.error, j.error_description].filter(Boolean).join(': ') || text
      if (j.error === 'invalid_grant' || j.error === 'invalid_client') throw new SignInNeeded(reason)
    } catch (err) {
      if (err instanceof SignInNeeded) throw err
    }
    throw new Error(`Spotify's token endpoint answered ${res.status}: ${reason}`)
  }
  return JSON.parse(text) as TokenResponse
}

function toTokens(clientId: string, j: TokenResponse, previous: SpotifyTokens | undefined, now: number): SpotifyTokens {
  const refreshToken = j.refresh_token ?? previous?.refreshToken
  if (!refreshToken) throw new Error('Spotify gave no refresh token')
  return {
    clientId,
    refreshToken,
    accessToken: j.access_token,
    expiresAt: now + j.expires_in * 1000,
    scope: j.scope ?? previous?.scope ?? '',
  }
}

/** The sign-in's last step: trade the code from the redirect for tokens. */
export async function exchangeCode(fetchFn: typeof fetch, clientId: string, code: string, verifier: string, now = Date.now()): Promise<SpotifyTokens> {
  const j = await postToken(fetchFn, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  })
  return toTokens(clientId, j, undefined, now)
}

/** Refresh this long before the access token expires, so a command never races its expiry. */
const EARLY_REFRESH_MS = 60_000

/**
 * Hands out an access token, refreshing it when it is close to expiry or
 * when Spotify has refused it, and saving whatever refresh token comes back.
 */
export class SpotifyAuth {
  private refreshing: Promise<SpotifyTokens> | undefined

  constructor(
    private readonly store: TokenStore,
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The saved tokens, or undefined when nobody has signed in on this Mac. */
  tokens(): SpotifyTokens | undefined {
    return this.store.read()
  }

  /** Rejects with SignInNeeded when there is nothing to refresh with, or Spotify refuses. */
  async accessToken(forceRefresh = false): Promise<string> {
    const tokens = this.store.read()
    if (!tokens) throw new SignInNeeded('nobody has signed in to Spotify on this Mac')
    if (!forceRefresh && tokens.expiresAt - this.now() > EARLY_REFRESH_MS) return tokens.accessToken
    // One refresh at a time: the old refresh token may stop working once a new one is issued.
    this.refreshing ??= this.refresh(tokens).finally(() => { this.refreshing = undefined })
    return (await this.refreshing).accessToken
  }

  private async refresh(tokens: SpotifyTokens): Promise<SpotifyTokens> {
    const j = await postToken(this.fetchFn, { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: tokens.clientId })
    const next = toTokens(tokens.clientId, j, tokens, this.now())
    this.store.write(next)
    return next
  }
}
