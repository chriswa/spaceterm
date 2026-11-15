/**
 * Spotify from the command line: the one-off sign-in, and Control's `spotify`
 * tool by hand (src/server/spotify).
 *
 *   npm run spotify -- login [<client id>]   # sign in; the client ID comes from ~/.spaceterm/spotify-client-id.txt if not given
 *   npm run spotify -- status                # any command line Control's tool takes; --help lists them
 *
 * Sign-in opens Spotify's consent page in the browser and waits, up to five
 * minutes, for it to come back to http://127.0.0.1:47791/callback, which must be
 * a redirect URI in the Spotify app's settings. The tokens go to
 * ~/.spaceterm/spotify.json; the server reads them from there, so no restart.
 */
import { execFile } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, readFileSync, rmSync } from 'fs'
import { createServer } from 'http'
import {
  authorizeUrl, CLIENT_ID_DROP_FILE, exchangeCode, fileTokenStore, isClientId, makePkce, REDIRECT_PORT, REDIRECT_URI, TOKEN_FILE,
} from '../server/spotify/auth'
import { Spotify } from '../server/spotify'

const SIGN_IN_TIMEOUT_MS = 5 * 60_000

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function clientIdFrom(given: string | undefined): string {
  const candidates: Array<[string, string | undefined]> = [
    ['the command line', given],
    [CLIENT_ID_DROP_FILE, existsSync(CLIENT_ID_DROP_FILE) ? readFileSync(CLIENT_ID_DROP_FILE, 'utf8').trim() : undefined],
    [TOKEN_FILE, fileTokenStore().read()?.clientId],
  ]
  for (const [where, id] of candidates) {
    if (!id) continue
    if (!isClientId(id)) fail(`The client ID from ${where} is not 32 hex digits: "${id}". Copy it from the Spotify app's settings page.`)
    return id
  }
  fail(`No client ID: paste it into ${CLIENT_ID_DROP_FILE}, or give it: npm run spotify -- login <client id>`)
}

function page(text: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Spaceterm Spotify</title><body style="font:16px system-ui;margin:3em">${text}</body>`
}

async function login(given: string | undefined): Promise<void> {
  const clientId = clientIdFrom(given)
  const pkce = makePkce()
  const state = randomBytes(16).toString('hex')
  const code = await new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const finish = (status: number, text: string, outcome: () => void) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(text))
        clearTimeout(timer)
        server.close()
        outcome()
      }
      const error = url.searchParams.get('error')
      if (error) return finish(400, `Spotify sign-in failed: ${error}`, () => reject(new Error(`Spotify said: ${error}`)))
      if (url.searchParams.get('state') !== state) return finish(400, 'Sign-in state did not match; run the login again.', () => reject(new Error('state mismatch')))
      const got = url.searchParams.get('code')
      if (!got) return finish(400, 'No code came back from Spotify.', () => reject(new Error('no code')))
      finish(200, 'Signed in to Spotify for Spaceterm. You can close this tab.', () => resolve(got))
    })
    timer = setTimeout(() => {
      server.close()
      reject(new Error('nobody finished signing in within five minutes'))
    }, SIGN_IN_TIMEOUT_MS)
    server.on('error', reject)
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const url = authorizeUrl(clientId, pkce, state)
      console.log(`Opening Spotify's sign-in page. If it does not open, visit:\n${url}`)
      execFile('open', [url], (err) => { if (err) console.error(`Could not open the browser: ${err.message}`) })
    })
  })
  const tokens = await exchangeCode(fetch, clientId, code, pkce.verifier)
  fileTokenStore().write(tokens)
  rmSync(CLIENT_ID_DROP_FILE, { force: true })
  console.log(`Signed in. Tokens saved to ${TOKEN_FILE}.\nGranted: ${tokens.scope}`)
  console.log(await new Spotify().run('devices'))
}

function quote(word: string): string {
  return /\s/.test(word) ? `"${word.replace(/"/g, '')}"` : word
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'login') return login(args[1])
  console.log(await new Spotify().run(args.map(quote).join(' ')))
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
