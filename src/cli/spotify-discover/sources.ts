import { readFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'
import { fileTokenStore, SpotifyAuth } from '../../server/spotify/auth'
import { CachedHttp } from './http'
import { normArtist, normTitle, type Features } from './pure'

/** The outside services spotify-discover asks, each a thin client over CachedHttp. */

export interface SpotifyTrack {
  id: string
  uri: string
  name: string
  artists: { id?: string; name: string }[]
  album?: { name: string }
  duration_ms: number
  external_ids?: { isrc?: string }
  is_local?: boolean
}

export class SpotifyClient {
  private readonly auth = new SpotifyAuth(fileTokenStore(), fetch)

  constructor(private readonly http: CachedHttp) {}

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.auth.accessToken()}` }
  }

  async get<T>(path: string, cache = false): Promise<T | undefined> {
    const url = path.startsWith('http') ? path : `https://api.spotify.com/v1${path}`
    return this.http.json<T>(url, { headers: await this.headers(), cache, okStatuses: [404] })
  }

  async send<T>(method: string, path: string, body: unknown): Promise<T | undefined> {
    return this.http.json<T>(`https://api.spotify.com/v1${path}`, {
      method, cache: false, body: JSON.stringify(body),
      headers: { ...(await this.headers()), 'Content-Type': 'application/json' },
    })
  }

  /** Every page of a paged list, following `next`. */
  async all<T>(path: string, pick: (page: { items: unknown[] }) => T[] = (p) => p.items as T[]): Promise<T[]> {
    const out: T[] = []
    let next: string | null | undefined = path
    while (next) {
      const page: { items: unknown[]; next?: string | null } | undefined = await this.get(next)
      if (!page) break
      out.push(...pick(page))
      next = page.next
    }
    return out
  }

  likedSongs(): Promise<SpotifyTrack[]> {
    return this.all('/me/tracks?limit=50', (p) => (p.items as { track: SpotifyTrack }[]).map((i) => i.track).filter((t) => t && !t.is_local))
  }

  /** The best match on Spotify for an artist and title, or undefined. */
  async find(artist: string, title: string): Promise<SpotifyTrack | undefined> {
    const clean = (s: string) => s.replace(/"/g, '')
    const q = `track:"${clean(title)}" artist:"${clean(artist)}"`
    const page = await this.get<{ tracks: { items: SpotifyTrack[] } }>(`/search?type=track&limit=5&q=${encodeURIComponent(q)}`, true)
    const wantArtist = normArtist(artist)
    const wantTitle = normTitle(title)
    const items = page?.tracks.items ?? []
    return items.find((t) => t.artists.some((a) => normArtist(a.name) === wantArtist) && normTitle(t.name) === wantTitle) ??
      items.find((t) => t.artists.some((a) => normArtist(a.name) === wantArtist) && normTitle(t.name).startsWith(wantTitle))
  }
}

interface ReccoItem extends Features {
  href: string
  isrc?: string
}

/** ReccoBeats' Spotify-style audio features, by Spotify ID, 40 at a time. Songs it does not know are left out. */
export async function reccoFeatures(http: CachedHttp, ids: string[]): Promise<Map<string, Features>> {
  const out = new Map<string, Features>()
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40)
    const res = await http.json<{ content: ReccoItem[] }>(`https://api.reccobeats.com/v1/audio-features?ids=${chunk.join(',')}`, { okStatuses: [400, 404] })
    for (const f of res?.content ?? []) {
      const id = /track\/([A-Za-z0-9]+)/.exec(f.href)?.[1]
      if (id) out.set(id, f)
    }
  }
  return out
}

export class LastFm {
  private readonly key = readFileSync(join(SOCKET_DIR, 'lastfm-api-key.txt'), 'utf8').split('\n')[0].trim()

  constructor(private readonly http: CachedHttp) {}

  private call<T>(method: string, params: Record<string, string | number>): Promise<T | undefined> {
    const q = new URLSearchParams({ method, api_key: this.key, format: 'json', autocorrect: '1', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) })
    return this.http.json<T>(`https://ws.audioscrobbler.com/2.0/?${q}`)
  }

  /** Tag name (lower case) to weight 0–100. */
  async artistTags(artist: string): Promise<Record<string, number>> {
    const j = await this.call<{ toptags?: { tag: { name: string; count: number }[] } }>('artist.gettoptags', { artist })
    const out: Record<string, number> = {}
    for (const t of j?.toptags?.tag ?? []) out[t.name.toLowerCase()] = Number(t.count)
    return out
  }

  async similarArtists(artist: string, limit = 30): Promise<{ name: string; match: number }[]> {
    const j = await this.call<{ similarartists?: { artist: { name: string; match: string }[] } }>('artist.getsimilar', { artist, limit })
    return (j?.similarartists?.artist ?? []).map((a) => ({ name: a.name, match: Number(a.match) }))
  }

  async similarTracks(artist: string, track: string, limit = 30): Promise<{ artist: string; title: string; match: number }[]> {
    const j = await this.call<{ similartracks?: { track: { name: string; match: number; artist: { name: string } }[] } }>('track.getsimilar', { artist, track, limit })
    return (j?.similartracks?.track ?? []).map((t) => ({ artist: t.artist.name, title: t.name, match: Number(t.match) }))
  }

  async artistTopTracks(artist: string, limit = 8): Promise<{ artist: string; title: string }[]> {
    const j = await this.call<{ toptracks?: { track: { name: string; artist: { name: string } }[] } }>('artist.gettoptracks', { artist, limit })
    return (j?.toptracks?.track ?? []).map((t) => ({ artist: t.artist.name, title: t.name }))
  }

  async tagTopTracks(tag: string, limit = 100, page = 1): Promise<{ artist: string; title: string }[]> {
    const j = await this.call<{ tracks?: { track: { name: string; artist: { name: string } }[] } }>('tag.gettoptracks', { tag, limit, page })
    return (j?.tracks?.track ?? []).map((t) => ({ artist: t.artist.name, title: t.name }))
  }
}

export class ListenBrainz {
  private readonly token = readFileSync(join(SOCKET_DIR, 'listenbrainz-token.txt'), 'utf8').trim()

  constructor(private readonly http: CachedHttp) {}

  /** LB Radio's songs for a prompt, such as `tag:(progressive house)` or `artist:(Deadmau5)`. */
  async radio(prompt: string, mode: 'easy' | 'medium' | 'hard' = 'easy'): Promise<{ artist: string; title: string }[]> {
    const j = await this.http.json<{ payload?: { jspf?: { playlist?: { track?: { creator: string; title: string }[] } } } }>(
      `https://api.listenbrainz.org/1/explore/lb-radio?prompt=${encodeURIComponent(prompt)}&mode=${mode}`,
      { headers: { Authorization: `Token ${this.token}` }, okStatuses: [400, 404] },
    )
    return (j?.payload?.jspf?.playlist?.track ?? []).map((t) => ({ artist: t.creator, title: t.title }))
  }
}

interface DeezerTrack {
  id: number
  preview?: string
  bpm?: number
  title?: string
}

/** Deezer's copy of a song by ISRC: its preview URL (signed, so fetched fresh, never cached) and BPM. */
export async function deezerByIsrc(http: CachedHttp, isrc: string): Promise<DeezerTrack | undefined> {
  const j = await http.json<DeezerTrack & { error?: unknown }>(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`, { cache: false, okStatuses: [404] })
  return j && !j.error && j.id ? j : undefined
}

/** Deezer's copy by artist and title, when there is no ISRC match. */
export async function deezerSearch(http: CachedHttp, artist: string, title: string): Promise<DeezerTrack | undefined> {
  const j = await http.json<{ data?: (DeezerTrack & { artist: { name: string } })[] }>(
    `https://api.deezer.com/search?q=${encodeURIComponent(`${artist} ${title}`)}&limit=5`, { cache: false },
  )
  return j?.data?.find((t) => normArtist(t.artist.name) === normArtist(artist) && normTitle(t.title ?? '') === normTitle(title))
}
