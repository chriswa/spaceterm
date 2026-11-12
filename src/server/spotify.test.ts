import { describe, expect, it } from 'vitest'
import { Spotify, type PlayerState } from './spotify'

/**
 * A Spotify that answers scripts as the real one does: `landsAt` maps a
 * volume asked for to the one it lands on, for Spotify's off-by-one volumes.
 */
function fakeSpotify(opts: { running?: boolean; state?: PlayerState; landsAt?: (asked: number) => number; stuck?: boolean } = {}) {
  let state: PlayerState = opts.state ?? 'playing'
  let volume = 60
  let track = 0
  const tracks = ['Plaza', 'Devil Rides Again']
  const actions: string[] = []
  const spotify = new Spotify(async (script) => {
    if (opts.running === false) return 'not-running'
    const set = /set sound volume to (\d+)/.exec(script)
    if (set) {
      actions.push(`volume ${set[1]}`)
      volume = (opts.landsAt ?? (n => n))(Number(set[1]))
    } else if (script.includes('next track')) {
      actions.push('next')
      track = (track + 1) % tracks.length
      state = 'playing'
    } else if (/^\s*pause$/m.test(script)) {
      actions.push('pause')
      if (!opts.stuck) state = 'paused'
    } else if (/^\s*play$/m.test(script)) {
      actions.push('play')
      if (!opts.stuck) state = 'playing'
    }
    return [state, String(volume), tracks[track], 'Lyst'].join('\n')
  })
  return { spotify, actions }
}

describe('Spotify', () => {
  it('plays, pauses and skips, saying what is playing afterwards', async () => {
    const { spotify, actions } = fakeSpotify()
    expect(await spotify.command({ command: 'pause' })).toMatchObject({ ok: true, state: 'paused' })
    expect(await spotify.command({ command: 'play' })).toMatchObject({ ok: true, state: 'playing' })
    expect(await spotify.command({ command: 'next' })).toEqual({ ok: true, state: 'playing', volume: 60, track: { name: 'Devil Rides Again', artist: 'Lyst' } })
    expect(actions).toEqual(['pause', 'play', 'next'])
  })

  it('reports failure when the player never reaches the state asked for', async () => {
    const { spotify } = fakeSpotify({ stuck: true })
    expect(await spotify.command({ command: 'pause' })).toEqual({ ok: false, problem: 'failed', message: 'Spotify is still playing' })
  })

  it('does nothing when Spotify is not open', async () => {
    const { spotify } = fakeSpotify({ running: false })
    expect(await spotify.command({ command: 'play' })).toEqual({ ok: false, problem: 'not-running' })
  })

  it('turns a failed script into a failure, never a rejection', async () => {
    const spotify = new Spotify(async () => { throw new Error('Not authorized to send Apple events to Spotify.') })
    expect(await spotify.command({ command: 'next' })).toEqual({ ok: false, problem: 'failed', message: 'Not authorized to send Apple events to Spotify.' })
  })

  it('sets the volume, clamped, once, reporting where it landed', async () => {
    const { spotify, actions } = fakeSpotify({ landsAt: n => n === 100 ? 100 : n - 1 })
    expect(await spotify.command({ command: 'volume', percent: 64 })).toMatchObject({ ok: true, volume: 63 })
    expect(await spotify.command({ command: 'volume', percent: 140 })).toMatchObject({ ok: true, volume: 100 })
    expect(actions).toEqual(['volume 64', 'volume 100'])
  })
})
