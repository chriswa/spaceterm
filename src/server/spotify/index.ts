import { execFile } from 'child_process'
import { fileTokenStore, SignInNeeded, SpotifyAuth, type TokenStore } from './auth'
import { parseWords, splitWords, type ParsedLine } from './command-line'
import { diskTasteFiles, stateWords, TasteStore, type TasteFiles, type TrackInfo } from './taste'

/**
 * Control's `spotify` tool: Spotify playback on any of the user's devices,
 * through Spotify's Web API and Spotify Connect, so the music can play on the
 * phone as easily as on the Mac.
 *
 * Every command is a row in COMMANDS, with its own usage and help; the tool
 * takes one command line, and `--help` lists them. A command that only reads
 * is a lookup, which Control runs silently; one that changes the music is an
 * action, which Control confirms aloud.
 *
 * Checked against Spotify in November 2026:
 * - Playback control needs Premium, and a device only shows up while its
 *   Spotify app is open (on a phone, recently in the foreground).
 * - Commands answer 204 before the player has changed, so a command polls
 *   the player until it shows what was asked, for up to SETTLE_MS, before
 *   saying what is playing.
 * - Pausing what is already paused answers 403 "Restriction violated", so
 *   play and pause look first.
 * - Some phones do not let Spotify set their volume (`supports_volume` false).
 * - Spotify's own "previous" restarts the song when it is a few seconds in,
 *   so `previous` checks the song changed and asks again when it did not;
 *   `restart` is the command that starts a song over.
 * - The API has no radio: recommendations and related artists were closed to
 *   new apps in November 2024, and artists' top tracks went in February
 *   2026. Playing one song leaves Spotify's Autoplay to carry on with
 *   similar ones, the nearest thing there is. Search returns at most 10.
 * - This Mac's Spotify app is listed under the Mac's computer name, as
 *   `scutil --get ComputerName` prints it ("Chris’s MacBook Pro"); another
 *   Mac signed in to the same account is a Computer too, so "mac" is matched
 *   by that name. The app takes a few seconds after launching to be listed.
 */

export const API_BASE = 'https://api.spotify.com/v1'
const SETTLE_POLLS = 8
const SETTLE_DELAY_MS = 200
const MAX_RETRY_AFTER_S = 3
/** How long to wait for this Mac's Spotify app to be listed after launching it. */
const LAUNCH_POLLS = 20
const LAUNCH_POLL_MS = 500

export interface SpotifyDeps {
  fetch: typeof fetch
  store: TokenStore
  sleep(ms: number): Promise<void>
  /** This Mac's computer name, which its Spotify app is listed under; undefined when it cannot tell. */
  thisMacName(): Promise<string | undefined>
  /** Open Spotify on this Mac without bringing it forward. Never rejects. */
  launchMacApp(): Promise<void>
  /** Epoch ms, for how long ago a song was played; Date.now when absent. */
  now?(): number
  /** Likes, dislikes and counted listens: see taste.ts. Kept in memory, so nothing is written, when absent. */
  taste?: TasteStore
}

/** Lines held in memory: a TasteStore that writes nothing to disk. */
export function memoryTasteFiles(): TasteFiles {
  const files = new Map<string, string[]>()
  return {
    readLines: (name) => [...(files.get(name) ?? [])],
    appendLine: (name, line) => { files.set(name, [...(files.get(name) ?? []), line]) },
  }
}

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim()))
  })
}

let macName: Promise<string | undefined> | undefined

const REAL_DEPS: SpotifyDeps = {
  fetch: (...args) => fetch(...args),
  store: fileTokenStore(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  thisMacName: () => (macName ??= run('/usr/sbin/scutil', ['--get', 'ComputerName']).then((name) => name || undefined)),
  launchMacApp: async () => { await run('/usr/bin/open', ['-g', '-a', 'Spotify']) },
  taste: new TasteStore(diskTasteFiles()),
}

/** Where the user is talking to Control from, which "here" and a plain play mean. */
export type Here = 'phone' | 'mac'

export interface RunContext {
  /** Undefined when nobody holds Control, so where the user is is unknown. */
  here?: Here
}

export interface Device {
  id: string | null
  is_active: boolean
  is_restricted?: boolean
  name: string
  type: string
  volume_percent: number | null
  supports_volume?: boolean
}

export interface Item {
  uri?: string
  name: string
  artists?: { name: string }[]
  show?: { name: string }
  album?: { name?: string }
  duration_ms?: number
}

export interface PlaybackState {
  device: Device
  is_playing: boolean
  progress_ms?: number | null
  item: Item | null
  /** The playlist, album or artist playing from, if any. */
  context?: { uri?: string } | null
}

interface Playlist {
  name: string
  uri: string
  owner?: { display_name?: string }
  /** `tracks` until February 2026, `items` since; only the count is read. */
  items?: { total?: number }
  tracks?: { total?: number }
}

/** What a play starts, when it starts something rather than resuming. */
type Start =
  | { body: { uris: string[] }; what: string; isPlaying(s: PlaybackState): boolean }
  | { body: { context_uri: string }; what: string; isPlaying(s: PlaybackState): boolean }

/** A command line Control got wrong: answered with how to get it right, never sent to Spotify. */
class UsageError extends Error {}

/** Spotify refused or failed a request. */
export class SpotifyApiError extends Error {
  /** `retryAfterS`: for a 429, the seconds Spotify asked to be left alone, when it said. */
  constructor(readonly status: number, readonly reason: string, readonly retryAfterS?: number) {
    super(`Spotify answered ${status}: ${reason}`)
  }
}

export type CommandKind = 'lookup' | 'action'

interface Command {
  /** One word, or words for a command in a group, such as "playlist add". */
  name: string
  kind: CommandKind
  usage: string
  summary: string
  /** More than the summary, for `<command> --help`. */
  details?: string
  /** The sign-in scopes this line needs beyond playback's, checked before Spotify is asked. */
  scopes?(line: ParsedLine): string[]
  run(spotify: Spotify, line: ParsedLine, args: string[], context: RunContext): Promise<string>
}

const ON_OPTION = `--on <device> picks the device: "phone", "mac" (this Mac, whose Spotify app is opened if it is closed), "here" (wherever the user is talking to Control from), or a word from its name as \`devices\` lists it. Without --on, play plays where the user is, and the other commands go to whichever device is playing now. Add --on only when the user names a device.`

const RECENT_SCOPE = 'user-read-recently-played'
const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative']
const LIBRARY_SCOPES = ['user-library-read', 'user-library-modify']
const HEARD_DEFAULT = 10
const RECENT_DEFAULT = 5
const RECENT_MAX = 50
const PLAYLIST_PAGE = 50
const PLAYLIST_MAX = 200
const SEARCH_LIMIT = 5

const COMMANDS: Command[] = [
  {
    name: 'status', kind: 'lookup', usage: 'status',
    summary: 'what is playing, on which device, and at what volume',
    run: (s) => s.status(),
  },
  {
    name: 'devices', kind: 'lookup', usage: 'devices',
    summary: 'the devices Spotify can play on right now',
    details: 'A phone is listed only while Spotify is open on it. If the user wants the phone and it is not listed, ask them to open Spotify on the phone, then try again.',
    run: (s) => s.devices(),
  },
  {
    name: 'play', kind: 'action', usage: 'play [--song "<words>" | --playlist "<name>"] [--on <device>]',
    summary: 'resume the music where the user is, or start a song or one of the user\'s playlists; with --on, on that device',
    details: [
      ON_OPTION,
      'A plain play, with nothing playing, plays on the device the user is talking from: the phone, or this Mac. "play --on phone" moves whatever was playing to the phone, from where it was, and plays it.',
      '--song "<words>" searches Spotify for a song, such as --song "mr brightside killers", and plays the best match; say the artist too when you know it. Spotify\'s API has no radio, but when a single song ends, Spotify\'s own Autoplay setting (on unless the user turned it off) usually carries on with similar songs: the nearest thing to radio from that song.',
      '--playlist "<name>" plays one of the user\'s own or followed playlists, matched by name; "playlists" lists them.',
      'A song or playlist plays where music is playing now, or else where the user is.',
    ].join(' '),
    scopes: (line) => (line.options.has('playlist') ? PLAYLIST_SCOPES : []),
    run: (s, line, _args, context) => {
      const song = option(line, 'song')
      const playlist = option(line, 'playlist')
      if (song !== undefined && playlist !== undefined) throw new UsageError('play takes --song or --playlist, not both')
      if (song !== undefined) return s.playSong(song, option(line, 'on'), context)
      if (playlist !== undefined) return s.playPlaylist(playlist, option(line, 'on'), context)
      return s.play(option(line, 'on'), context)
    },
  },
  {
    name: 'pause', kind: 'action', usage: 'pause [--on <device>]',
    summary: 'pause the music',
    details: ON_OPTION,
    run: (s, line, _args, context) => s.pause(option(line, 'on'), context),
  },
  {
    name: 'next', kind: 'action', usage: 'next [--on <device>]',
    summary: 'skip to the next song',
    details: ON_OPTION,
    run: (s, line, _args, context) => s.next(option(line, 'on'), context),
  },
  {
    name: 'previous', kind: 'action', usage: 'previous [--on <device>]',
    summary: 'go back to the song before this one',
    details: `${ON_OPTION} Always the song before, for "go back a song", "previous song" or "the last song". To start this song over, use restart.`,
    run: (s, line, _args, context) => s.previous(option(line, 'on'), context),
  },
  {
    name: 'restart', kind: 'action', usage: 'restart [--on <device>]',
    summary: 'start this song over from the beginning',
    details: `${ON_OPTION} For "start this song over" or "from the top". For the song before this one, use previous.`,
    run: (s, line, _args, context) => s.restart(option(line, 'on'), context),
  },
  {
    name: 'recent', kind: 'lookup', usage: `recent [<count>]`,
    summary: `the songs played most recently, newest first (${RECENT_DEFAULT} unless a count up to ${RECENT_MAX} is given)`,
    details: 'Spotify counts only songs played for 30 seconds or more, and leaves out podcasts. The song playing now is in status, not here until it has played.',
    scopes: () => [RECENT_SCOPE],
    run: (s, _line, args) => {
      const count = args.length ? Number(args[0]) : RECENT_DEFAULT
      if (args.length > 1 || !Number.isInteger(count) || count < 1 || count > RECENT_MAX) {
        throw new UsageError(`recent takes a count from 1 to ${RECENT_MAX}, such as "recent 10"`)
      }
      return s.recent(count)
    },
  },
  {
    name: 'playlists', kind: 'lookup', usage: 'playlists [<words>]',
    summary: 'the user\'s own and followed playlists; with words, only those whose names contain them',
    details: 'Play one with play --playlist "<name>".',
    scopes: () => PLAYLIST_SCOPES,
    run: (s, _line, args) => s.playlists(args.join(' ')),
  },
  {
    name: 'like', kind: 'action', usage: 'like',
    summary: 'the user likes the song playing now: kept in their taste log, and saved to their Liked Songs',
    details: 'For "I like this song", "love this one" or "save this". Confirm in a word or two, such as "Liked.".',
    scopes: () => LIBRARY_SCOPES,
    run: (s) => s.like(),
  },
  {
    name: 'dislike', kind: 'action', usage: 'dislike',
    summary: 'the user dislikes the song playing now: skipped at once, and never played again (blocked)',
    details: 'For "I don\'t like this song", "skip this and never play it again" or "ban this one". It is kept in the taste log; a blocked song is skipped whenever it comes up, on any device. If it was in Liked Songs it is taken out. Confirm briefly, such as "Blocked and skipped.". Undo with unblock.',
    scopes: () => LIBRARY_SCOPES,
    run: (s, _line, _args, context) => s.dislike(context),
  },
  {
    name: 'blocked', kind: 'lookup', usage: 'blocked',
    summary: 'the songs the user has disliked, which are skipped whenever they come up',
    run: async (s) => s.blockedList(),
  },
  {
    name: 'unblock', kind: 'action', usage: 'unblock <words>',
    summary: 'stop skipping a disliked song, named by words of its title or artist',
    run: async (s, _line, args) => {
      if (!args.length) throw new UsageError('unblock needs words from the song\'s name or artist, such as "unblock plaza"')
      return s.unblock(args.join(' '))
    },
  },
  {
    name: 'heard', kind: 'lookup', usage: `heard [<count>]`,
    summary: `the songs the user has actually listened to, newest first, with how often each (${HEARD_DEFAULT} unless a count is given)`,
    details: 'A song counts as heard once the user listened past its halfway point while around; paused or unattended playback does not count. Unlike recent, this is Spaceterm\'s own log.',
    run: async (s, _line, args) => {
      const count = args.length ? Number(args[0]) : HEARD_DEFAULT
      if (args.length > 1 || !Number.isInteger(count) || count < 1) throw new UsageError('heard takes a count, such as "heard 20"')
      return s.heard(count)
    },
  },
  {
    name: 'taste', kind: 'lookup', usage: 'taste',
    summary: 'a summary of the user\'s taste log: songs liked, disliked and heard, and their most listened artists and songs',
    run: async (s) => s.tasteSummary(),
  },
  {
    name: 'volume', kind: 'action', usage: 'volume <0-100> [--on <device>]',
    summary: "set the music's volume on the device playing it, as a percentage",
    details: `${ON_OPTION} This is Spotify's own volume on that device. Some phones do not let Spotify set it; the answer says so.`,
    run: (s, line, args, context) => {
      const percent = Number(args[0])
      if (args.length !== 1 || !Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new UsageError('volume needs one percentage from 0 to 100, such as "volume 40"')
      }
      return s.volume(Math.round(percent), option(line, 'on'), context)
    },
  },
]

function option(line: ParsedLine, name: string): string | undefined {
  const value = line.options.get(name)
  return typeof value === 'string' ? value : undefined
}

/** The command a line's leading words name, and the words after it. The longest name wins, so "playlist add" beats "playlist". */
function findCommand(positional: readonly string[]): { command: Command; args: string[] } | undefined {
  let best: { command: Command; args: string[] } | undefined
  for (const command of COMMANDS) {
    const words = command.name.split(' ')
    if (words.every((w, i) => positional[i]?.toLowerCase() === w) && (!best || words.length > best.command.name.split(' ').length)) {
      best = { command, args: positional.slice(words.length) }
    }
  }
  return best
}

const KNOWN_OPTIONS = new Set(['help', 'on', 'song', 'playlist'])

/** The whole tool's help, for `--help`, a bare call, or a command it does not know. */
export function overallHelp(): string {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length))
  return [
    'spotify: control Spotify playback on the user\'s devices (the Mac, the phone, speakers), through Spotify Connect.',
    'Call it as {"tool": "spotify", "args": "<command line>"}. Commands:',
    ...COMMANDS.map((c) => `  ${c.usage.padEnd(width)}  ${c.summary}`),
    '',
    ON_OPTION,
    '"<command> --help" says more about one command.',
    'status, devices, recent, playlists, heard, taste and blocked only look; the others change the music.',
    'There is no radio in Spotify\'s API: play --song plays one song, after which Spotify\'s Autoplay usually carries on with similar ones.',
  ].join('\n')
}

function commandHelp(command: Command): string {
  return [`spotify ${command.usage}: ${command.summary}.`, command.details].filter(Boolean).join('\n')
}

/**
 * Whether a command line only looks (status, devices, any help, and anything
 * it cannot read, whose answer is how to call it) or changes the music.
 */
export function commandKind(args: string): CommandKind {
  try {
    const line = parseWords(splitWords(args))
    if (line.options.has('help')) return 'lookup'
    return findCommand(line.positional)?.command.kind ?? 'lookup'
  } catch {
    return 'lookup'
  }
}

function trackText(item: PlaybackState['item']): string {
  if (!item) return 'nothing'
  const by = item.artists?.map((a) => a.name).join(', ') || item.show?.name
  return by ? `"${item.name}" by ${by}` : `"${item.name}"`
}

/** How long ago, roughly, in words: "4 minutes ago". */
function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (minutes < 1) return 'just now'
  if (minutes < 60) return unit(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (hours < 48) return unit(hours, 'hour')
  return unit(Math.round(hours / 24), 'day')
}

function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean)
}

function containsAll(name: string, query: string): boolean {
  const lower = name.toLowerCase()
  return words(query).every((w) => lower.includes(w))
}

function playlistText(p: Playlist): string {
  const total = p.items?.total ?? p.tracks?.total
  return `"${p.name}"${total === undefined ? '' : `, ${total} song${total === 1 ? '' : 's'}`}`
}

/** The playlist `query` names: exactly first, then by all its words; or why none or several do. */
function pickPlaylist(query: string, playlists: readonly Playlist[]): Playlist | string {
  const exact = playlists.filter((p) => p.name.trim().toLowerCase() === query.trim().toLowerCase())
  if (exact.length === 1) return exact[0]
  const candidates = exact.length ? exact : playlists.filter((p) => containsAll(p.name, query))
  if (candidates.length === 1) return candidates[0]
  if (!candidates.length) return `None of the user's playlists is called "${query}". "playlists" lists them.`
  const shown = candidates.slice(0, 10).map((p) => `"${p.name}"`).join(', ')
  return `"${query}" could be any of these playlists: ${shown}${candidates.length > 10 ? `, and ${candidates.length - 10} more` : ''}. Ask the user which.`
}

function deviceText(device: Device): string {
  return `${device.name} (${device.type})`
}

function stateText(state: PlaybackState | undefined): string {
  if (!state) return 'Nothing is playing on any device'
  const volume = state.device.volume_percent === null || state.device.supports_volume === false
    ? ''
    : `, at ${state.device.volume_percent}% volume`
  return `${state.is_playing ? 'Playing' : 'Paused'}: ${trackText(state.item)}, on ${deviceText(state.device)}${volume}`
}

/** Words that mean a kind of device rather than a name. */
const DEVICE_TYPES: Record<string, string> = {
  phone: 'Smartphone', iphone: 'Smartphone', mobile: 'Smartphone', android: 'Smartphone', smartphone: 'Smartphone',
  mac: 'Computer', computer: 'Computer', laptop: 'Computer', desktop: 'Computer', macbook: 'Computer',
  tablet: 'Tablet', ipad: 'Tablet',
  speaker: 'Speaker', tv: 'TV',
}

/** Names compared as Spotify and `scutil` may spell them: case and apostrophes aside. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\u2018\u2019`]/g, "'")
  return norm(a) === norm(b)
}

/** Whether `query` means this Mac rather than a device by name. */
function meansThisMac(query: string): boolean {
  return DEVICE_TYPES[query.trim().toLowerCase()] === 'Computer'
}

/** This Mac's device, when it is listed: by its computer name, or the only Computer when the name is unknown. */
function thisMacDevice(devices: readonly Device[], macName: string | undefined): Device | undefined {
  const usable = devices.filter((d) => d.id)
  if (macName) return usable.find((d) => sameName(d.name, macName))
  const apps = usable.filter((d) => d.type === 'Computer' && !/web player/i.test(d.name))
  return apps.length === 1 ? apps[0] : undefined
}

/** The device `query` names, or why none or several do. `macName` is this Mac's, which "mac" means. */
function pickDevice(query: string, devices: readonly Device[], macName?: string): Device | string {
  const q = query.trim().toLowerCase()
  const usable = devices.filter((d) => d.id)
  const named = usable.filter((d) => sameName(d.name, q))
  const type = DEVICE_TYPES[q]
  const thisMac = !named.length && type === 'Computer' && macName ? usable.filter((d) => sameName(d.name, macName)) : []
  const candidates = named.length ? named
    : thisMac.length ? thisMac
    : type ? usable.filter((d) => d.type === type)
    : usable.filter((d) => d.name.toLowerCase().includes(q))
  // A Spotify tab in a browser is a Computer too, but "mac" means the app.
  const preferred = candidates.filter((d) => !/web player/i.test(d.name))
  const ranked = [...(preferred.length ? preferred : candidates)].sort((a, b) => Number(b.is_active) - Number(a.is_active))
  if (ranked.length === 1 || ranked[0]?.is_active) return ranked[0]
  const seen = usable.length ? `Spotify can play on: ${usable.map(deviceText).join(', ')}` : 'Spotify sees no devices at all'
  if (!ranked.length) {
    const hint = type === 'Smartphone' ? ' Ask the user to open Spotify on the phone, then try again.'
      : type === 'Computer' ? ' Spotify was opened on this Mac but did not show up; it may need signing in there.'
      : ''
    return `No device matches "${query}". ${seen}.${hint}`
  }
  return `"${query}" could be any of: ${ranked.map(deviceText).join(', ')}. Name one with --on.`
}

/** A song as the taste log keeps it. */
function trackInfo(item: Item): TrackInfo {
  return {
    uri: item.uri ?? '',
    name: item.name,
    artists: item.artists?.map((a) => a.name) ?? [],
    ...(item.album?.name ? { album: item.album.name } : {}),
    ...(item.duration_ms ? { durationMs: item.duration_ms } : {}),
  }
}

function infoText(track: TrackInfo): string {
  return track.artists.length ? `"${track.name}" by ${track.artists.join(', ')}` : `"${track.name}"`
}

/** Where a song was playing, for the taste log. */
function where(state: PlaybackState): { device?: string; context?: string } {
  return { device: state.device.name, ...(state.context?.uri ? { context: state.context.uri } : {}) }
}

export class Spotify {
  private readonly auth: SpotifyAuth
  readonly taste: TasteStore
  private readonly listeners = new Set<(command: string) => void>()

  constructor(private readonly deps: SpotifyDeps = REAL_DEPS) {
    this.auth = new SpotifyAuth(deps.store, deps.fetch)
    this.taste = deps.taste ?? new TasteStore(memoryTasteFiles(), deps.now)
  }

  /** Called after each command Control runs, with its name: the skip watcher's sign that the user is about, and its cue to look again. */
  onCommand(listener: (command: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** This Mac's computer name, which its Spotify app is listed under. */
  thisMacName(): Promise<string | undefined> {
    return this.deps.thisMacName()
  }

  /** Whether anyone has signed in on this Mac, so there is a player to watch. */
  signedIn(): boolean {
    return !!this.auth.tokens()
  }

  /**
   * Run one command line, such as "play --on phone". `context.here` is where
   * the user is talking from. Never rejects: every failure is a line saying
   * what went wrong.
   */
  async run(args: string, context: RunContext = {}): Promise<string> {
    let line: ParsedLine
    try {
      line = parseWords(splitWords(args))
    } catch (err) {
      return `spotify: ${err instanceof Error ? err.message : String(err)}\n\n${overallHelp()}`
    }
    const found = findCommand(line.positional)
    if (!found) {
      if (!line.positional.length) return overallHelp()
      return `spotify: there is no "${line.positional.join(' ')}" command.\n\n${overallHelp()}`
    }
    if (line.options.has('help')) return commandHelp(found.command)
    const unknown = [...line.options.keys()].filter((name) => !KNOWN_OPTIONS.has(name))
    if (unknown.length) return `spotify: ${found.command.name} has no --${unknown[0]} option.\n\n${commandHelp(found.command)}`
    const granted = this.auth.tokens()?.scope.split(/\s+/)
    const missing = granted ? (found.command.scopes?.(line) ?? []).filter((scope) => !granted.includes(scope)) : []
    if (missing.length) {
      return `spotify ${found.command.name}: not allowed yet: the user needs to sign in again with "npm run spotify -- login" in the Spaceterm repo, to grant ${missing.join(' and ')}. An agent can run it for them; they click Agree in the browser.`
    }
    try {
      return await found.command.run(this, line, found.args, context)
    } catch (err) {
      return this.failure(found.command, err)
    } finally {
      for (const listener of this.listeners) listener(found.command.name)
    }
  }

  /** A command's failure, as the line Control is answered with. */
  private failure(command: Command, err: unknown): string {
    if (err instanceof UsageError) return `spotify: ${err.message}\n\n${commandHelp(command)}`
    if (err instanceof SignInNeeded) {
      return `spotify: not signed in to Spotify (${err.message}). The user signs in once on the Mac by running "npm run spotify -- login" in the Spaceterm repo; an agent can do it for them.`
    }
    if (err instanceof SpotifyApiError) return `spotify ${command.name} failed: ${this.explain(err)}`
    return `spotify ${command.name} failed: ${err instanceof Error ? err.message : String(err)}`
  }

  private explain(err: SpotifyApiError): string {
    if (err.status === 403 && /premium/i.test(err.reason)) return 'Spotify says this needs Premium.'
    if (err.status === 403 && /scope/i.test(err.reason)) return `${err.message}. The sign-in lacks a permission; sign in again with "npm run spotify -- login".`
    if (err.status === 404) return `${err.message}. No device is active: name one with --on, or ask the user to open Spotify.`
    return err.message
  }

  async status(): Promise<string> {
    const state = await this.state()
    const uri = state?.item?.uri
    if (state) return `${stateText(state)}${uri?.startsWith('spotify:track:') ? `. This song: ${stateWords(this.taste.get(uri))}` : ''}`
    return `${stateText(undefined)}. ${await this.devices()}`
  }

  async devices(): Promise<string> {
    const devices = await this.deviceList()
    if (!devices.length) return 'Spotify sees no devices. Spotify must be open on a device, such as the phone, for it to show up.'
    return `Spotify can play on:\n${devices.map((d) => `- ${deviceText(d)}${d.is_active ? ', active' : ''}${d.is_restricted ? ', cannot be controlled' : ''}`).join('\n')}`
  }

  /**
   * With --on, move the music there and play it. Without, music already
   * playing anywhere is left where it is; otherwise it plays where the user
   * is, or, when that is unknown, resumes where it was, or on this Mac when
   * nothing was active.
   */
  async play(on: string | undefined, context: RunContext): Promise<string> {
    if (on) return this.playOn(on, context)
    const before = await this.state()
    if (before?.is_playing) return `Already playing. ${stateText(before)}`
    if (context.here) return this.playOn(context.here, context)
    if (!before) return this.playOn('mac', context)
    await this.request('PUT', '/me/player/play')
    return stateText(await this.settle((s) => s.is_playing))
  }

  private async playOn(on: string, context: RunContext): Promise<string> {
    const device = await this.device(on, context)
    if (typeof device === 'string') return device
    await this.request('PUT', '/me/player', { body: { device_ids: [device.id], play: true } })
    return stateText(await this.settle((s) => s.device.id === device.id && s.is_playing))
  }

  async pause(on: string | undefined, context: RunContext): Promise<string> {
    const target = await this.target(on, context)
    if (typeof target === 'string') return target
    const before = await this.state()
    // Only the active device plays, so any other one is already paused.
    const pausedThere = !before?.is_playing || (target.id !== undefined && before.device.id !== target.id)
    if (pausedThere) return `Already paused. ${stateText(before)}`
    await this.request('PUT', '/me/player/pause', { query: target.id ? { device_id: target.id } : {} })
    return stateText(await this.settle((s) => !s.is_playing))
  }

  async next(on: string | undefined, context: RunContext): Promise<string> {
    const target = await this.target(on, context)
    if (typeof target === 'string') return target
    const before = await this.state()
    await this.request('POST', '/me/player/next', { query: target.id ? { device_id: target.id } : {} })
    return stateText(await this.settle((s) => s.item?.uri !== before?.item?.uri))
  }

  /** The song before this one, never this one from the top: Spotify's previous restarts a song a few seconds in, so it is asked again when the song did not change. */
  async previous(on: string | undefined, context: RunContext): Promise<string> {
    const target = await this.target(on, context)
    if (typeof target === 'string') return target
    const query: Record<string, string> = target.id ? { device_id: target.id } : {}
    const before = await this.state()
    if (!before) return `${stateText(undefined)}, so there is no song to go back from: name a device with --on.`
    const uri = before.item?.uri
    let after: PlaybackState | undefined = before
    for (let attempt = 0; attempt < 2; attempt++) {
      const from = after
      await this.request('POST', '/me/player/previous', { query })
      after = await this.settle((s) => s.item?.uri !== uri || (s.progress_ms ?? 0) + 1000 < (from?.progress_ms ?? 0))
      if (after?.item?.uri !== uri) return stateText(after)
    }
    return `There is no song before this one here; it started over instead. ${stateText(after)}`
  }

  /** This song from the beginning. */
  async restart(on: string | undefined, context: RunContext): Promise<string> {
    const target = await this.target(on, context)
    if (typeof target === 'string') return target
    if (!target.id && !(await this.state())) return `${stateText(undefined)}, so there is no song to start over.`
    await this.request('PUT', '/me/player/seek', { query: { position_ms: 0, ...(target.id ? { device_id: target.id } : {}) } })
    return `Started over. ${stateText(await this.settle((s) => (s.progress_ms ?? 0) < 3000))}`
  }

  async recent(count: number): Promise<string> {
    const j = await this.request<{ items?: { track: Item; played_at: string }[] }>('GET', '/me/player/recently-played', { query: { limit: count } })
    const items = j?.items ?? []
    if (!items.length) return 'Spotify has no recently played songs.'
    const now = this.deps.now?.() ?? Date.now()
    return `Played most recently, newest first:\n${items.map((it, i) => `${i + 1}. ${trackText(it.track)}, ${ago(now - Date.parse(it.played_at))}`).join('\n')}`
  }

  async playlists(query: string): Promise<string> {
    const all = await this.playlistList()
    const shown = query.trim() ? all.filter((p) => containsAll(p.name, query)) : all
    if (!all.length) return 'The user has no playlists of their own or followed.'
    if (!shown.length) return `None of the user's ${all.length} playlists has "${query}" in its name.`
    return `${query.trim() ? `The user's playlists matching "${query}"` : 'The user\'s playlists'}:\n${shown.map((p) => `- ${playlistText(p)}`).join('\n')}`
  }

  async playSong(query: string, on: string | undefined, context: RunContext): Promise<string> {
    if (!query.trim()) throw new UsageError('--song needs words to search for, such as --song "mr brightside"')
    const j = await this.request<{ tracks?: { items?: Item[] } }>('GET', '/search', { query: { q: query, type: 'track', limit: SEARCH_LIMIT } })
    const track = j?.tracks?.items?.find((t) => t.uri)
    if (!track?.uri) return `Spotify found no song for "${query}".`
    const uri = track.uri
    return this.start({ body: { uris: [uri] }, what: trackText(track), isPlaying: (s) => s.item?.uri === uri }, on, context)
  }

  async playPlaylist(query: string, on: string | undefined, context: RunContext): Promise<string> {
    if (!query.trim()) throw new UsageError('--playlist needs a name, such as --playlist "Road trip"')
    const picked = pickPlaylist(query, await this.playlistList())
    if (typeof picked === 'string') return picked
    const uri = picked.uri
    return this.start({ body: { context_uri: uri }, what: `the playlist "${picked.name}"`, isPlaying: (s) => s.context?.uri === uri }, on, context)
  }

  /**
   * Start a song or playlist: on the --on device; else where music is
   * playing now; else where the user is; else where it was last; else on
   * this Mac.
   */
  private async start(start: Start, on: string | undefined, context: RunContext): Promise<string> {
    let deviceId: string | undefined
    const choose = async (query: string): Promise<string | undefined> => {
      const device = await this.device(query, context)
      if (typeof device === 'string') return device
      deviceId = device.id ?? undefined
      return undefined
    }
    if (on) {
      const problem = await choose(on)
      if (problem) return problem
    } else {
      const before = await this.state()
      if (before?.is_playing || (before && !context.here)) deviceId = before.device.id ?? undefined
      else {
        const problem = await choose(context.here ?? 'mac')
        if (problem) return problem
      }
    }
    await this.request('PUT', '/me/player/play', { query: deviceId ? { device_id: deviceId } : {}, body: start.body })
    const after = await this.settle((s) => s.is_playing && start.isPlaying(s))
    return after && start.isPlaying(after) ? stateText(after) : `Asked Spotify to play ${start.what}. ${stateText(after)}`
  }

  private async playlistList(): Promise<Playlist[]> {
    const all: Playlist[] = []
    for (let offset = 0; offset < PLAYLIST_MAX; offset += PLAYLIST_PAGE) {
      const page = await this.request<{ items?: (Playlist | null)[]; next?: string | null }>('GET', '/me/playlists', { query: { limit: PLAYLIST_PAGE, offset } })
      all.push(...(page?.items ?? []).filter((p): p is Playlist => !!p?.uri && !!p.name))
      if (!page?.next) break
    }
    return all
  }

  async volume(percent: number, on: string | undefined, context: RunContext): Promise<string> {
    let device: Device | undefined
    if (on) {
      const picked = await this.device(on, context)
      if (typeof picked === 'string') return picked
      device = picked
    } else {
      device = (await this.state())?.device
      if (!device) return `${stateText(undefined)}, so there is no volume to set: use volume ${percent} --on <device>.`
    }
    if (device.supports_volume === false) return `${deviceText(device)} does not let Spotify set its volume; the user has to change it on the device.`
    await this.request('PUT', '/me/player/volume', { query: { volume_percent: percent, ...(on && device.id ? { device_id: device.id } : {}) } })
    const after = await this.settle((s) => s.device.id !== device.id || s.device.volume_percent === percent)
    return after?.device.id === device.id ? stateText(after) : `Set ${deviceText(device)} to ${percent}% volume`
  }

  /** The song playing now as the taste log keeps it, or why there is none to judge. */
  private async currentTrack(): Promise<{ state: PlaybackState; track: TrackInfo } | string> {
    const state = await this.state()
    const item = state?.item
    if (!state || !item) return `${stateText(undefined)}, so there is no song to judge.`
    if (!item.uri?.startsWith('spotify:track:')) return `${trackText(item)} is not a song (a podcast, say), so it is not kept in the taste log.`
    return { state, track: trackInfo(item) }
  }

  async like(): Promise<string> {
    const current = await this.currentTrack()
    if (typeof current === 'string') return current
    const { state, track } = current
    await this.request('PUT', '/me/library', { query: { uris: track.uri } })
    const was = this.taste.get(track.uri)?.verdict
    this.taste.setVerdict('like', track, where(state))
    return `Liked ${trackText(state.item)}: saved to Liked Songs${was === 'dislike' ? ', and no longer blocked' : ''}.`
  }

  async dislike(context: RunContext): Promise<string> {
    const current = await this.currentTrack()
    if (typeof current === 'string') return current
    const { state, track } = current
    const saved = await this.request<boolean[]>('GET', '/me/library/contains', { query: { uris: track.uri } })
    if (saved?.[0]) await this.request('DELETE', '/me/library', { query: { uris: track.uri } })
    this.taste.setVerdict('dislike', track, where(state))
    const skipped = await this.next(undefined, context)
    return `Blocked ${trackText(state.item)}${saved?.[0] ? ', and took it out of Liked Songs' : ''}; it will be skipped whenever it comes up. Skipped: ${skipped}`
  }

  blockedList(): string {
    const blocked = this.taste.blocked()
    if (!blocked.length) return 'No songs are blocked.'
    return `Blocked songs, skipped whenever they come up:\n${blocked.map((r) => `- ${infoText(r.track)}`).join('\n')}`
  }

  unblock(query: string): string {
    const matches = this.taste.blocked().filter((r) => containsAll(`${r.track.name} ${r.track.artists.join(' ')}`, query))
    if (!matches.length) return `No blocked song matches "${query}". "blocked" lists them.`
    if (matches.length > 1) return `"${query}" could be any of: ${matches.map((r) => infoText(r.track)).join(', ')}. Ask the user which.`
    this.taste.setVerdict('unblock', matches[0].track)
    return `Unblocked ${infoText(matches[0].track)}; it can play again.`
  }

  heard(count: number): string {
    const listens = this.taste.recentListens(count)
    if (!listens.length) return 'No listens are logged yet.'
    const now = this.deps.now?.() ?? Date.now()
    return `Listened to most recently, newest first:\n${listens.map((e, i) => {
      const r = this.taste.get(e.track.uri)
      return `${i + 1}. ${infoText(e.track)}, ${ago(now - Date.parse(e.at))}; ${stateWords(r)}`
    }).join('\n')}`
  }

  tasteSummary(): string {
    const all = this.taste.all()
    const heard = all.filter((r) => r.listens > 0)
    const liked = all.filter((r) => r.verdict === 'like')
    const disliked = all.filter((r) => r.verdict === 'dislike')
    const plays = heard.reduce((n, r) => n + r.listens, 0)
    const byArtist = new Map<string, number>()
    for (const r of heard) for (const a of r.track.artists) byArtist.set(a, (byArtist.get(a) ?? 0) + r.listens)
    const topArtists = [...byArtist].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([a, n]) => `${a} (${n})`)
    const topSongs = [...heard].sort((a, b) => b.listens - a.listens).slice(0, 5).map((r) => `${infoText(r.track)} (${r.listens})`)
    return [
      `Taste log: ${liked.length} liked, ${disliked.length} disliked (blocked); ${heard.length} different songs heard, ${plays} listens in all.`,
      `Heard and liked: ${heard.filter((r) => r.verdict === 'like').length}; heard and disliked: ${heard.filter((r) => r.verdict === 'dislike').length}; heard with no verdict: ${heard.filter((r) => !r.verdict).length}.`,
      topArtists.length ? `Most listened artists: ${topArtists.join(', ')}.` : '',
      topSongs.length ? `Most listened songs: ${topSongs.join(', ')}.` : '',
    ].filter(Boolean).join('\n')
  }

  /** The player now, for the skip watcher: undefined when nothing is active. Rejects as requests do. */
  playerState(): Promise<PlaybackState | undefined> {
    return this.state()
  }

  /** The song queued after the one playing, for the skip watcher. */
  async upNext(): Promise<Item | undefined> {
    const j = await this.request<{ queue?: Item[] }>('GET', '/me/player/queue')
    return j?.queue?.[0]
  }

  /** Skip to the next song on the active device, without waiting to see it: the skip watcher checks for itself. */
  async skipNow(): Promise<void> {
    await this.request('POST', '/me/player/next')
  }

  /** The device --on names (`id` undefined without --on), or why it names none. */
  private async target(on: string | undefined, context: RunContext): Promise<{ id?: string } | string> {
    if (!on) return {}
    const device = await this.device(on, context)
    return typeof device === 'string' ? device : { id: device.id ?? undefined }
  }

  /** The device --on names: "here" as where the user is, and this Mac opened first when it is not listed. */
  private async device(on: string, context: RunContext): Promise<Device | string> {
    let query = on
    if (query.trim().toLowerCase() === 'here') {
      if (!context.here) return 'Where the user is talking from is not known, so "here" names no device: use --on phone or --on mac.'
      query = context.here
    }
    const macName = meansThisMac(query) ? await this.deps.thisMacName() : undefined
    let devices = await this.deviceList()
    if (meansThisMac(query) && !thisMacDevice(devices, macName)) devices = await this.openOnThisMac(macName)
    const picked = pickDevice(query, devices, macName)
    if (typeof picked !== 'string' && picked.is_restricted) return `${deviceText(picked)} does not let Spotify control it.`
    return picked
  }

  /** Open Spotify on this Mac and wait for it to be listed; the devices last seen either way. */
  private async openOnThisMac(macName: string | undefined): Promise<Device[]> {
    await this.deps.launchMacApp()
    let devices: Device[] = []
    for (let poll = 0; poll < LAUNCH_POLLS; poll++) {
      await this.deps.sleep(LAUNCH_POLL_MS)
      devices = await this.deviceList()
      if (thisMacDevice(devices, macName)) break
    }
    return devices
  }

  private async deviceList(): Promise<Device[]> {
    const j = await this.request<{ devices: Device[] }>('GET', '/me/player/devices')
    return j?.devices ?? []
  }

  /** The player now, or undefined when nothing is active. */
  private async state(): Promise<PlaybackState | undefined> {
    const state = await this.request<PlaybackState>('GET', '/me/player')
    return state?.device ? state : undefined
  }

  /** Poll the player until `done` holds of it, for up to SETTLE_POLLS polls; the last state seen either way. */
  private async settle(done: (s: PlaybackState) => boolean): Promise<PlaybackState | undefined> {
    let state: PlaybackState | undefined
    for (let poll = 0; poll < SETTLE_POLLS; poll++) {
      state = await this.state()
      if (state && done(state)) return state
      await this.deps.sleep(SETTLE_DELAY_MS)
    }
    return state
  }

  /** One Web API request: JSON back, or undefined for an empty answer. Refreshes once on 401 and waits out a short 429. */
  private async request<T>(method: string, path: string, init: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T | undefined> {
    const url = new URL(API_BASE + path)
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, String(v))
    let refreshed = false
    let waited = false
    for (;;) {
      const token = await this.auth.accessToken(refreshed)
      const res = await this.deps.fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      })
      if (res.status === 401 && !refreshed) {
        refreshed = true
        continue
      }
      const retryAfter = Number(res.headers.get('Retry-After'))
      if (res.status === 429 && !waited && retryAfter <= MAX_RETRY_AFTER_S) {
        waited = true
        await this.deps.sleep(Math.max(1, retryAfter) * 1000)
        continue
      }
      const text = await res.text()
      if (!res.ok) {
        let reason = text || res.statusText
        try {
          reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? reason
        } catch { /* not JSON */ }
        throw new SpotifyApiError(res.status, reason, res.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined)
      }
      // Commands such as pause and next answer 200 with a bare snapshot id, not JSON; only the reads have a body to parse.
      return text && /json/i.test(res.headers.get('Content-Type') ?? '') ? JSON.parse(text) as T : undefined
    }
  }
}
