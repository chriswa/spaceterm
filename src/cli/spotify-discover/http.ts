import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Every outside request spotify-discover makes, cached on disk and paced per
 * host, so a rerun (or next week's refinement) asks each service only for
 * what it has not answered before.
 */

export const USER_AGENT = 'spaceterm-spotify-discover/0.1 (personal playlist tool)'

/** Least gap between two requests to a host, in ms. MusicBrainz and ListenBrainz ask for one a second. */
const GAP_MS: Record<string, number> = {
  'musicbrainz.org': 1100,
  'api.listenbrainz.org': 1100,
  'labs.api.listenbrainz.org': 1100,
  'ws.audioscrobbler.com': 250,
  'api.spotify.com': 250,
  'api.reccobeats.com': 300,
  'api.deezer.com': 150,
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export interface FetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Cache the answer (default true for GET). */
  cache?: boolean
  /** Statuses that are an answer, cached like a 200, rather than a failure: a 404 for "no such song". */
  okStatuses?: number[]
}

export class CachedHttp {
  private readonly last = new Map<string, number>()
  requests = 0
  hits = 0

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private path(key: string): string {
    const hash = createHash('sha1').update(key).digest('hex')
    const sub = join(this.dir, hash.slice(0, 2))
    mkdirSync(sub, { recursive: true })
    return join(sub, `${hash}.json`)
  }

  /** The JSON body, or undefined for an okStatus that is not 200. Throws on anything else after retries. */
  async json<T>(url: string, opts: FetchOptions = {}): Promise<T | undefined> {
    const method = opts.method ?? 'GET'
    const cache = opts.cache ?? method === 'GET'
    const key = `${method} ${url} ${opts.body ?? ''}`
    const file = this.path(key)
    if (cache && existsSync(file)) {
      this.hits++
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { status: number; body: T | null }
      return saved.status === 200 ? saved.body ?? undefined : undefined
    }
    const host = new URL(url).hostname
    for (let attempt = 0; ; attempt++) {
      const gap = GAP_MS[host] ?? 300
      const wait = (this.last.get(host) ?? 0) + gap - Date.now()
      if (wait > 0) await sleep(wait)
      this.last.set(host, Date.now())
      this.requests++
      let res: Response
      try {
        res = await fetch(url, { method, headers: { 'User-Agent': USER_AGENT, ...opts.headers }, body: opts.body })
      } catch (err) {
        if (attempt < 4) { await sleep(2000 * (attempt + 1)); continue }
        throw err
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 6) throw new Error(`${host} answered ${res.status} after ${attempt + 1} tries: ${url}`)
        const after = Number(res.headers.get('Retry-After'))
        await sleep(Math.max(Number.isFinite(after) && after > 0 ? after * 1000 : 0, 2000 * 2 ** attempt))
        continue
      }
      const text = await res.text()
      if (res.status === 200) {
        let body: T
        try {
          body = JSON.parse(text) as T
        } catch {
          throw new Error(`${host} answered 200 with non-JSON: ${text.slice(0, 120)}`)
        }
        if (cache) writeFileSync(file, JSON.stringify({ status: 200, body }))
        return body
      }
      if (opts.okStatuses?.includes(res.status)) {
        if (cache) writeFileSync(file, JSON.stringify({ status: res.status, body: null }))
        return undefined
      }
      throw new Error(`${host} answered ${res.status}: ${text.slice(0, 200)}`)
    }
  }
}
