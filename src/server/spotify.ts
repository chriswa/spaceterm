import { execFile } from 'child_process'

/**
 * Spotify on this Mac, driven through its AppleScript dictionary: what
 * Control's music tools do.
 *
 * Checked against Spotify on macOS in November 2026:
 * - Every command first asks whether Spotify is running, which does not launch
 *   it. A `tell application "Spotify"` alone would.
 * - `pause` takes up to about a quarter of a second to show in `player state`,
 *   which reads the old state until then, so a command waits for the state it
 *   asked for before reporting.
 * - `next track` plays the next track even when paused, and its name reads
 *   back at once.
 * - `set sound volume to N` often lands one below N (50 reads back 49), which
 *   is near enough: the volume reported is the one it landed on.
 */

export type SpotifyCommand =
  | { command: 'play' }
  | { command: 'pause' }
  | { command: 'next' }
  /** 0 to 100. */
  | { command: 'volume'; percent: number }

export type PlayerState = 'playing' | 'paused' | 'stopped'

export type SpotifyOutcome =
  | { ok: true; state: PlayerState; volume: number; track?: { name: string; artist: string } }
  | { ok: false; problem: 'not-running' }
  /** Spotify did something other than asked, or AppleScript failed: `message` says which. */
  | { ok: false; problem: 'failed'; message: string }

/** Run an AppleScript and resolve with what it returns, trimmed. Rejects when it fails. */
export type RunAppleScript = (script: string) => Promise<string>

const REAL_RUN: RunAppleScript = (script) => new Promise((resolve, reject) => {
  execFile('osascript', ['-e', script], { timeout: 10_000 }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr.trim() || err.message))
    else resolve(stdout.trim())
  })
})

const NOT_RUNNING = 'not-running'

/** How long a command waits for `player state` to show what it asked for. */
const SETTLE_POLLS = 20
const SETTLE_DELAY_S = 0.05

/**
 * A script that does `action` and returns the player's state, volume and
 * track a line each, or `not-running`. With `until`, it first waits, up to a
 * second, for the player to reach that state.
 */
function script(action: string, until?: PlayerState): string {
  const settle = until
    ? `repeat ${SETTLE_POLLS} times
    if player state is ${until} then exit repeat
    delay ${SETTLE_DELAY_S}
  end repeat`
    : ''
  return `if application "Spotify" is not running then return "${NOT_RUNNING}"
tell application "Spotify"
  ${action}
  ${settle}
  set trackName to ""
  set trackArtist to ""
  try
    set trackName to name of current track
    set trackArtist to artist of current track
  end try
  return (player state as text) & linefeed & (sound volume as text) & linefeed & trackName & linefeed & trackArtist
end tell`
}

function parse(output: string): SpotifyOutcome {
  if (output === NOT_RUNNING) return { ok: false, problem: 'not-running' }
  const [state, volume, name = '', artist = ''] = output.split('\n')
  if (state !== 'playing' && state !== 'paused' && state !== 'stopped') {
    return { ok: false, problem: 'failed', message: `Spotify answered "${output}"` }
  }
  return { ok: true, state, volume: Number(volume), ...(name ? { track: { name, artist } } : {}) }
}

export class Spotify {
  constructor(private readonly run: RunAppleScript = REAL_RUN) {}

  /** Never rejects. */
  async command(command: SpotifyCommand): Promise<SpotifyOutcome> {
    try {
      switch (command.command) {
        case 'play': return this.expect(parse(await this.run(script('play', 'playing'))), 'playing')
        case 'pause': return this.expect(parse(await this.run(script('pause', 'paused'))), 'paused')
        case 'next': return parse(await this.run(script('next track')))
        case 'volume': return parse(await this.run(script(`set sound volume to ${Math.min(100, Math.max(0, Math.round(command.percent)))}`)))
      }
    } catch (err) {
      return { ok: false, problem: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
  }

  private expect(outcome: SpotifyOutcome, state: PlayerState): SpotifyOutcome {
    if (!outcome.ok || outcome.state === state) return outcome
    return { ok: false, problem: 'failed', message: `Spotify is still ${outcome.state}` }
  }
}
