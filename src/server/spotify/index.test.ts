import { describe, expect, it } from 'vitest'
import { SCOPES, type SpotifyTokens, type TokenStore } from './auth'
import { commandKind, Spotify } from './index'

interface FakeDevice {
  id: string
  name: string
  type: string
  volume_percent: number
  supports_volume?: boolean
}

const MAC: FakeDevice = { id: 'mac', name: 'MacBook Pro', type: 'Computer', volume_percent: 60 }
const PHONE: FakeDevice = { id: 'phone', name: "Chris's iPhone", type: 'Smartphone', volume_percent: 80 }
const TRACKS = [
  { uri: 'spotify:track:1', name: 'Plaza', artists: [{ name: 'Lyst' }] },
  { uri: 'spotify:track:2', name: 'Devil Rides Again', artists: [{ name: 'Lyst' }, { name: 'Ana' }] },
  { uri: 'spotify:track:3', name: 'Mr. Brightside', artists: [{ name: 'The Killers' }] },
]
/** 120 playlists, so listing them takes three pages; a few with names worth matching. */
const PLAYLISTS = [
  { name: 'Road Trip', uri: 'spotify:playlist:road', items: { total: 40 } },
  { name: 'Road Trip 2', uri: 'spotify:playlist:road2', items: { total: 12 } },
  { name: 'Focus Beats', uri: 'spotify:playlist:focus', items: { total: 1 } },
  ...Array.from({ length: 116 }, (_, i) => ({ name: `Mix ${i}`, uri: `spotify:playlist:mix${i}`, items: { total: 10 } })),
  { name: 'Late Night Synthwave', uri: 'spotify:playlist:synth', items: { total: 77 } },
]
const NOW = Date.parse('2026-11-15T20:00:00Z')

/**
 * Spotify's Web API as these commands meet it: the devices, one player, and
 * the token endpoint. `staleToken` makes the first API call answer 401.
 */
function fakeSpotify(opts: {
  devices?: FakeDevice[]; active?: string; playing?: boolean; tokens?: SpotifyTokens | null; staleToken?: boolean; refreshFails?: boolean
  /** This Mac's computer name; MAC's by default. */
  macName?: string
  /** Listed once Spotify is launched on this Mac. */
  launchAdds?: FakeDevice
  /** Where in the song the player is, in ms. */
  progress?: number
  /** Which of TRACKS is playing. */
  track?: number
} = {}) {
  const devices = (opts.devices ?? [MAC, PHONE]).map((d) => ({ ...d }))
  let active = opts.active === undefined ? 'mac' : opts.active
  let playing = opts.playing ?? true
  let track = opts.track ?? 0
  let progress = opts.progress ?? 0
  let context: string | undefined
  let stale = opts.staleToken ?? false
  const calls: string[] = []
  let saved: SpotifyTokens | undefined = opts.tokens === null ? undefined : opts.tokens ?? {
    clientId: 'c'.repeat(32), refreshToken: 'refresh-1', accessToken: 'access-1', expiresAt: Date.now() + 3_600_000, scope: SCOPES.join(' '),
  }
  const store: TokenStore = { read: () => saved, write: (t) => { saved = t } }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
  /** What Spotify now answers a command with: 200 and a snapshot id as plain text, rather than 204. */
  const snapshot = () => new Response('y-870dyliBB4cvLxlbrx', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  const empty = () => new Response(null, { status: 204 })
  const deviceJson = (d: FakeDevice) => ({ ...d, is_active: d.id === active, supports_volume: d.supports_volume ?? true })

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.hostname === 'accounts.spotify.com') {
      const body = new URLSearchParams(String(init?.body))
      calls.push(`token ${body.get('grant_type')} ${body.get('refresh_token')}`)
      if (opts.refreshFails) return json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400)
      return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: saved?.scope })
    }
    const device = url.searchParams.get('device_id')
    calls.push(`${method} ${url.pathname.replace('/v1', '')}${device ? ` @${device}` : ''}`)
    if (stale) {
      stale = false
      return json({ error: { status: 401, message: 'The access token expired' } }, 401)
    }
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${saved?.accessToken}`)
    const current = devices.find((d) => d.id === (device ?? active))
    switch (`${method} ${url.pathname}`) {
      case 'GET /v1/me/player/devices': return json({ devices: devices.map(deviceJson) })
      case 'GET /v1/me/player': {
        const on = devices.find((d) => d.id === active)
        return on ? json({ device: deviceJson(on), is_playing: playing, progress_ms: progress, item: TRACKS[track], context: context ? { uri: context } : null }) : empty()
      }
      case 'PUT /v1/me/player': {
        active = (JSON.parse(String(init?.body)) as { device_ids: string[] }).device_ids[0]
        playing = true
        return empty()
      }
      case 'PUT /v1/me/player/play': {
        if (!current) return json({ error: { status: 404, message: 'Player command failed: No active device found' } }, 404)
        active = current.id
        const body = init?.body ? JSON.parse(String(init.body)) as { uris?: string[]; context_uri?: string } : {}
        if (body.uris) {
          track = TRACKS.findIndex((t) => t.uri === body.uris?.[0])
          context = undefined
          progress = 0
        }
        if (body.context_uri) {
          context = body.context_uri
          track = 0
          progress = 0
        }
        playing = true
        return empty()
      }
      case 'POST /v1/me/player/previous':
        // As Spotify does: a few seconds in, previous starts the song over.
        if (progress <= 3000 && track > 0) track--
        progress = 0
        return snapshot()
      case 'PUT /v1/me/player/seek':
        progress = Number(url.searchParams.get('position_ms'))
        return snapshot()
      case 'GET /v1/me/player/recently-played': {
        const played = [
          { track: TRACKS[1], played_at: new Date(NOW - 4 * 60_000).toISOString() },
          { track: TRACKS[0], played_at: new Date(NOW - 3 * 3_600_000).toISOString() },
        ]
        return json({ items: played.slice(0, Number(url.searchParams.get('limit'))) })
      }
      case 'GET /v1/me/playlists': {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit'))
        expect(limit).toBeLessThanOrEqual(50)
        return json({ items: PLAYLISTS.slice(offset, offset + limit), next: offset + limit < PLAYLISTS.length ? 'more' : null })
      }
      case 'GET /v1/search': {
        expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(10)
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        return json({ tracks: { items: TRACKS.filter((t) => q.split(' ').some((w) => t.name.toLowerCase().includes(w))) } })
      }
      case 'PUT /v1/me/player/pause':
        if (!playing) return json({ error: { status: 403, message: 'Player command failed: Restriction violated' } }, 403)
        playing = false
        return snapshot()
      case 'POST /v1/me/player/next':
        track = (track + 1) % TRACKS.length
        progress = 0
        return snapshot()
      case 'PUT /v1/me/player/volume':
        if (current) current.volume_percent = Number(url.searchParams.get('volume_percent'))
        return empty()
    }
    return json({ error: { status: 404, message: 'Service not found' } }, 404)
  }) as typeof fetch

  const spotify = new Spotify({
    fetch: fetchFn, store, sleep: async () => {}, now: () => NOW,
    thisMacName: async () => 'macName' in opts ? opts.macName : MAC.name,
    launchMacApp: async () => {
      calls.push('launch Spotify')
      if (opts.launchAdds) devices.push({ ...opts.launchAdds })
    },
  })
  return { spotify, calls, saved: () => saved }
}

describe('Spotify', () => {
  it('moves the music to the phone with play --on phone', async () => {
    const s = fakeSpotify({ playing: false })
    expect(await s.spotify.run('play --on phone')).toBe('Playing: "Plaza" by Lyst, on Chris\'s iPhone (Smartphone), at 80% volume')
    expect(s.calls).toContain('PUT /me/player')
  })

  it('says to open Spotify on the phone when the phone is not listed', async () => {
    const s = fakeSpotify({ devices: [MAC] })
    const answer = await s.spotify.run('play --on phone')
    expect(answer).toContain('No device matches "phone". Spotify can play on: MacBook Pro (Computer).')
    expect(answer).toContain('open Spotify on the phone')
  })

  it('pauses, and says when it was already paused rather than failing', async () => {
    const s = fakeSpotify()
    expect(await s.spotify.run('pause')).toBe('Paused: "Plaza" by Lyst, on MacBook Pro (Computer), at 60% volume')
    expect(await s.spotify.run('pause')).toMatch(/^Already paused\. /)
    expect(s.calls.filter((c) => c.startsWith('PUT /me/player/pause'))).toHaveLength(1)
  })

  it('resumes, skips, and sets the volume on the device playing', async () => {
    const s = fakeSpotify({ playing: false })
    expect(await s.spotify.run('play')).toMatch(/^Playing: "Plaza"/)
    expect(await s.spotify.run('next')).toBe('Playing: "Devil Rides Again" by Lyst, Ana, on MacBook Pro (Computer), at 60% volume')
    expect(await s.spotify.run('volume 35')).toContain('at 35% volume')
  })

  it('names a device by a word of its name, and sends the command to it', async () => {
    const s = fakeSpotify({ active: 'phone' })
    expect(await s.spotify.run('volume 20 --on macbook')).toBe('Set MacBook Pro (Computer) to 20% volume')
    expect(s.calls).toContain('PUT /me/player/volume @mac')
  })

  it('says when a phone will not let Spotify set its volume', async () => {
    const s = fakeSpotify({ devices: [MAC, { ...PHONE, supports_volume: false }], active: 'phone' })
    expect(await s.spotify.run('volume 40')).toContain('does not let Spotify set its volume')
    expect(s.calls).not.toContain('PUT /me/player/volume')
  })

  it('says what to do when nothing is active', async () => {
    const s = fakeSpotify({ active: '' })
    expect(await s.spotify.run('status')).toContain('Nothing is playing on any device. Spotify can play on:\n- MacBook Pro (Computer)')
    // Nothing active and nobody known to hold Control: this Mac.
    expect(await s.spotify.run('play')).toBe('Playing: "Plaza" by Lyst, on MacBook Pro (Computer), at 60% volume')
  })

  it('takes "mac" to mean this Mac, by its computer name, when another Mac is signed in too', async () => {
    const work: FakeDevice = { id: 'work', name: 'Spare 0248-Chris Waddell', type: 'Computer', volume_percent: 50 }
    const mine: FakeDevice = { id: 'mine', name: 'Chris\u2019s MacBook Pro', type: 'Computer', volume_percent: 40 }
    const s = fakeSpotify({ devices: [work, mine, PHONE], active: 'phone', playing: false, macName: "Chris's MacBook Pro" })
    expect(await s.spotify.run('play --on mac')).toBe('Playing: "Plaza" by Lyst, on Chris\u2019s MacBook Pro (Computer), at 40% volume')
    expect(s.calls).not.toContain('launch Spotify')
  })

  it('opens Spotify on this Mac when it is not listed, and plays there once it is', async () => {
    const s = fakeSpotify({ devices: [PHONE], active: 'phone', playing: false, launchAdds: MAC })
    expect(await s.spotify.run('play --on laptop')).toBe('Playing: "Plaza" by Lyst, on MacBook Pro (Computer), at 60% volume')
    expect(s.calls.indexOf('launch Spotify')).toBeLessThan(s.calls.indexOf('PUT /me/player'))
  })

  it('says so when Spotify on this Mac never shows up', async () => {
    const s = fakeSpotify({ devices: [PHONE], active: 'phone' })
    const answer = await s.spotify.run('play --on mac')
    expect(answer).toContain('No device matches "mac"')
    expect(answer).toContain('did not show up')
    expect(s.calls).not.toContain('PUT /me/player')
  })

  it('plays where the user is talking from when nothing is playing', async () => {
    const atMac = fakeSpotify({ active: 'phone', playing: false })
    expect(await atMac.spotify.run('play', { here: 'mac' })).toMatch(/on MacBook Pro \(Computer\)/)
    const onPhone = fakeSpotify({ active: 'mac', playing: false })
    expect(await onPhone.spotify.run('play', { here: 'phone' })).toMatch(/on Chris's iPhone \(Smartphone\)/)
    expect(await onPhone.spotify.run('pause --on here', {})).toContain('"here" names no device')
  })

  it('leaves music already playing where it is, and pauses it there from anywhere', async () => {
    const s = fakeSpotify({ active: 'phone' })
    expect(await s.spotify.run('play', { here: 'mac' })).toMatch(/^Already playing\. .*iPhone/)
    expect(await s.spotify.run('pause', { here: 'mac' })).toMatch(/^Paused: .*iPhone/)
    expect(s.calls).not.toContain('PUT /me/player')
  })

  it('goes back to the song before, asking again when Spotify only started this one over', async () => {
    const early = fakeSpotify({ track: 1, progress: 1000 })
    expect(await early.spotify.run('previous')).toBe('Playing: "Plaza" by Lyst, on MacBook Pro (Computer), at 60% volume')
    expect(early.calls.filter((c) => c === 'POST /me/player/previous')).toHaveLength(1)

    const late = fakeSpotify({ track: 1, progress: 95_000 })
    expect(await late.spotify.run('previous')).toBe('Playing: "Plaza" by Lyst, on MacBook Pro (Computer), at 60% volume')
    expect(late.calls.filter((c) => c === 'POST /me/player/previous')).toHaveLength(2)

    const first = fakeSpotify({ track: 0, progress: 95_000 })
    expect(await first.spotify.run('previous --on phone')).toMatch(/^There is no song before this one here/)
    expect(first.calls.filter((c) => c === 'POST /me/player/previous @phone')).toHaveLength(2)
  })

  it('starts this song over with restart, without changing the song', async () => {
    const s = fakeSpotify({ track: 1, progress: 95_000 })
    expect(await s.spotify.run('restart')).toBe('Started over. Playing: "Devil Rides Again" by Lyst, Ana, on MacBook Pro (Computer), at 60% volume')
    expect(s.calls).toContain('PUT /me/player/seek')
    expect(s.calls).not.toContain('POST /me/player/previous')
  })

  it('lists recently played songs, newest first, with how long ago', async () => {
    const s = fakeSpotify()
    expect(await s.spotify.run('recent')).toBe('Played most recently, newest first:\n1. "Devil Rides Again" by Lyst, Ana, 4 minutes ago\n2. "Plaza" by Lyst, 3 hours ago')
    expect(await s.spotify.run('recent 1')).not.toContain('Plaza')
    expect(await s.spotify.run('recent 99')).toContain('recent takes a count from 1 to 50')
  })

  it('lists every playlist across pages, or those matching words', async () => {
    const s = fakeSpotify()
    const all = await s.spotify.run('playlists')
    expect(all).toContain('- "Late Night Synthwave", 77 songs')
    expect(all).toContain('- "Focus Beats", 1 song\n')
    expect(s.calls.filter((c) => c === 'GET /me/playlists')).toHaveLength(3)
    expect(await s.spotify.run('playlists synthwave night')).toBe('The user\'s playlists matching "synthwave night":\n- "Late Night Synthwave", 77 songs')
  })

  it('plays a playlist by name: exactly first, then by its words, and asks when several match', async () => {
    const s = fakeSpotify({ playing: false })
    expect(await s.spotify.run('play --playlist "road trip"', { here: 'phone' })).toMatch(/^Playing: "Plaza" by Lyst, on Chris's iPhone/)
    expect(s.calls).toContain('PUT /me/player/play @phone')
    expect(await s.spotify.run('play --playlist synthwave')).toMatch(/^Playing: /)
    expect(await s.spotify.run('play --playlist road')).toBe('"road" could be any of these playlists: "Road Trip", "Road Trip 2". Ask the user which.')
    expect(await s.spotify.run('play --playlist polka')).toContain('None of the user\'s playlists is called "polka"')
  })

  it('plays a searched-for song where music is playing, even over what is playing', async () => {
    const s = fakeSpotify({ active: 'phone' })
    expect(await s.spotify.run('play --song "brightside killers"', { here: 'mac' })).toBe('Playing: "Mr. Brightside" by The Killers, on Chris\'s iPhone (Smartphone), at 80% volume')
    expect(await s.spotify.run('play --song zzzz')).toBe('Spotify found no song for "zzzz".')
    expect(await s.spotify.run('play --song a --playlist b')).toContain('play takes --song or --playlist, not both')
  })

  it('says to sign in again, without asking Spotify, when the sign-in lacks a scope', async () => {
    const s = fakeSpotify({ tokens: { clientId: 'c'.repeat(32), refreshToken: 'r', accessToken: 'a', expiresAt: Date.now() + 3_600_000, scope: 'user-modify-playback-state' } })
    expect(await s.spotify.run('recent')).toContain('not allowed yet: the user needs to sign in again with "npm run spotify -- login"')
    expect(await s.spotify.run('play --playlist road')).toContain('playlist-read-private and playlist-read-collaborative')
    expect(s.calls).toEqual([])
    expect(await s.spotify.run('play --song brightside')).toMatch(/^Playing: "Mr. Brightside"/)
  })

  it('refreshes once when Spotify refuses the token, and keeps the refresh token it hands back', async () => {
    const s = fakeSpotify({ staleToken: true })
    expect(await s.spotify.run('status')).toMatch(/^Playing: /)
    expect(s.calls).toEqual(['GET /me/player', 'token refresh_token refresh-1', 'GET /me/player'])
    expect(s.saved()).toMatchObject({ refreshToken: 'refresh-2', accessToken: 'access-2' })
  })

  it('refreshes ahead of an expiring token', async () => {
    const s = fakeSpotify({ tokens: { clientId: 'c'.repeat(32), refreshToken: 'refresh-1', accessToken: 'old', expiresAt: Date.now() + 10_000, scope: '' } })
    await s.spotify.run('devices')
    expect(s.calls[0]).toBe('token refresh_token refresh-1')
    expect(s.saved()?.refreshToken).toBe('refresh-2')
  })

  it('says how to sign in when nobody has, or Spotify refuses the refresh', async () => {
    expect(await fakeSpotify({ tokens: null }).spotify.run('status')).toContain('npm run spotify -- login')
    const revoked = fakeSpotify({ staleToken: true, refreshFails: true })
    expect(await revoked.spotify.run('pause')).toContain('not signed in to Spotify (invalid_grant: Refresh token revoked)')
  })

  it('answers help, unknown commands and bad arguments without calling Spotify', async () => {
    const s = fakeSpotify()
    expect(await s.spotify.run('--help')).toContain('previous [--on <device>]')
    expect(await s.spotify.run('')).toContain('Commands:')
    expect(await s.spotify.run('play --help')).toContain('"play --on phone" moves')
    expect(await s.spotify.run('shuffle')).toContain('there is no "shuffle" command')
    expect(await s.spotify.run('volume loud')).toContain('volume needs one percentage from 0 to 100')
    expect(await s.spotify.run('pause --device phone')).toContain('pause has no --device option')
    expect(s.calls).toEqual([])
  })
})

describe('commandKind', () => {
  it('calls looking a lookup and changing the music an action', () => {
    for (const args of ['status', 'devices', '--help', '', 'play --help', 'shuffle', 'play --on "phone', 'recent', 'recent 10', 'playlists road']) expect(commandKind(args)).toBe('lookup')
    for (const args of ['play', 'play --on phone', 'pause', 'next', 'previous', 'restart', 'volume 40', 'VOLUME 40', 'play --song "x"', 'play --playlist road']) expect(commandKind(args)).toBe('action')
  })
})
