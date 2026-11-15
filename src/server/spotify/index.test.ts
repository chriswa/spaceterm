import { describe, expect, it } from 'vitest'
import type { SpotifyTokens, TokenStore } from './auth'
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
]

/**
 * Spotify's Web API as these commands meet it: the devices, one player, and
 * the token endpoint. `staleToken` makes the first API call answer 401.
 */
function fakeSpotify(opts: { devices?: FakeDevice[]; active?: string; playing?: boolean; tokens?: SpotifyTokens | null; staleToken?: boolean; refreshFails?: boolean } = {}) {
  const devices = (opts.devices ?? [MAC, PHONE]).map((d) => ({ ...d }))
  let active = opts.active === undefined ? 'mac' : opts.active
  let playing = opts.playing ?? true
  let track = 0
  let stale = opts.staleToken ?? false
  const calls: string[] = []
  let saved: SpotifyTokens | undefined = opts.tokens === null ? undefined : opts.tokens ?? {
    clientId: 'c'.repeat(32), refreshToken: 'refresh-1', accessToken: 'access-1', expiresAt: Date.now() + 3_600_000, scope: 'user-modify-playback-state',
  }
  const store: TokenStore = { read: () => saved, write: (t) => { saved = t } }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const empty = () => new Response(null, { status: 204 })
  const deviceJson = (d: FakeDevice) => ({ ...d, is_active: d.id === active, supports_volume: d.supports_volume ?? true })

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.hostname === 'accounts.spotify.com') {
      const body = new URLSearchParams(String(init?.body))
      calls.push(`token ${body.get('grant_type')} ${body.get('refresh_token')}`)
      if (opts.refreshFails) return json({ error: 'invalid_grant', error_description: 'Refresh token revoked' }, 400)
      return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: 'user-modify-playback-state' })
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
        return on ? json({ device: deviceJson(on), is_playing: playing, item: TRACKS[track] }) : empty()
      }
      case 'PUT /v1/me/player': {
        active = (JSON.parse(String(init?.body)) as { device_ids: string[] }).device_ids[0]
        playing = true
        return empty()
      }
      case 'PUT /v1/me/player/play':
        if (!current) return json({ error: { status: 404, message: 'Player command failed: No active device found' } }, 404)
        playing = true
        return empty()
      case 'PUT /v1/me/player/pause':
        if (!playing) return json({ error: { status: 403, message: 'Player command failed: Restriction violated' } }, 403)
        playing = false
        return empty()
      case 'POST /v1/me/player/next':
        track = (track + 1) % TRACKS.length
        return empty()
      case 'PUT /v1/me/player/volume':
        if (current) current.volume_percent = Number(url.searchParams.get('volume_percent'))
        return empty()
    }
    return json({ error: { status: 404, message: 'Service not found' } }, 404)
  }) as typeof fetch

  const spotify = new Spotify({ fetch: fetchFn, store, sleep: async () => {} })
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
    expect(await s.spotify.run('play')).toContain('use play --on <device>')
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
    expect(await s.spotify.run('--help')).toContain('play [--on <device>]')
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
    for (const args of ['status', 'devices', '--help', '', 'play --help', 'shuffle', 'play --on "phone']) expect(commandKind(args)).toBe('lookup')
    for (const args of ['play', 'play --on phone', 'pause', 'next', 'volume 40', 'VOLUME 40']) expect(commandKind(args)).toBe('action')
  })
})
