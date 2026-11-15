import { fileTokenStore, SignInNeeded, SpotifyAuth, type TokenStore } from './auth'
import { parseWords, splitWords, type ParsedLine } from './command-line'

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
 */

export const API_BASE = 'https://api.spotify.com/v1'
const SETTLE_POLLS = 8
const SETTLE_DELAY_MS = 200
const MAX_RETRY_AFTER_S = 3

export interface SpotifyDeps {
  fetch: typeof fetch
  store: TokenStore
  sleep(ms: number): Promise<void>
}

const REAL_DEPS: SpotifyDeps = {
  fetch: (...args) => fetch(...args),
  store: fileTokenStore(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

interface Device {
  id: string | null
  is_active: boolean
  is_restricted?: boolean
  name: string
  type: string
  volume_percent: number | null
  supports_volume?: boolean
}

interface PlaybackState {
  device: Device
  is_playing: boolean
  item: { uri?: string; name: string; artists?: { name: string }[]; show?: { name: string } } | null
}

/** A command line Control got wrong: answered with how to get it right, never sent to Spotify. */
class UsageError extends Error {}

/** Spotify refused or failed a request. */
class SpotifyApiError extends Error {
  constructor(readonly status: number, readonly reason: string) {
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
  run(spotify: Spotify, line: ParsedLine, args: string[]): Promise<string>
}

const ON_OPTION = `--on <device> picks the device: "phone", "mac", or a word from its name as \`devices\` lists it. Without --on, the command goes to whichever device is playing now.`

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
    name: 'play', kind: 'action', usage: 'play [--on <device>]',
    summary: 'resume the music; with --on, move it to that device and play it there',
    details: `${ON_OPTION} "play --on phone" moves whatever was playing to the phone, from where it was, and plays it. It cannot choose a song, artist or playlist.`,
    run: (s, line) => s.play(option(line, 'on')),
  },
  {
    name: 'pause', kind: 'action', usage: 'pause [--on <device>]',
    summary: 'pause the music',
    details: ON_OPTION,
    run: (s, line) => s.pause(option(line, 'on')),
  },
  {
    name: 'next', kind: 'action', usage: 'next [--on <device>]',
    summary: 'skip to the next song',
    details: ON_OPTION,
    run: (s, line) => s.next(option(line, 'on')),
  },
  {
    name: 'volume', kind: 'action', usage: 'volume <0-100> [--on <device>]',
    summary: "set the music's volume on the device playing it, as a percentage",
    details: `${ON_OPTION} This is Spotify's own volume on that device. Some phones do not let Spotify set it; the answer says so.`,
    run: (s, line, args) => {
      const percent = Number(args[0])
      if (args.length !== 1 || !Number.isFinite(percent) || percent < 0 || percent > 100) {
        throw new UsageError('volume needs one percentage from 0 to 100, such as "volume 40"')
      }
      return s.volume(Math.round(percent), option(line, 'on'))
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

const KNOWN_OPTIONS = new Set(['help', 'on'])

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
    'status and devices only look; the others change the music.',
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

/** The device `query` names, or why none or several do. */
function pickDevice(query: string, devices: readonly Device[]): Device | string {
  const q = query.trim().toLowerCase()
  const usable = devices.filter((d) => d.id)
  const named = usable.filter((d) => d.name.toLowerCase() === q)
  const type = DEVICE_TYPES[q]
  const candidates = named.length ? named
    : type ? usable.filter((d) => d.type === type)
    : usable.filter((d) => d.name.toLowerCase().includes(q))
  // A Spotify tab in a browser is a Computer too, but "mac" means the app.
  const preferred = candidates.filter((d) => !/web player/i.test(d.name))
  const ranked = [...(preferred.length ? preferred : candidates)].sort((a, b) => Number(b.is_active) - Number(a.is_active))
  if (ranked.length === 1 || ranked[0]?.is_active) return ranked[0]
  const seen = usable.length ? `Spotify can play on: ${usable.map(deviceText).join(', ')}` : 'Spotify sees no devices at all'
  if (!ranked.length) {
    const hint = type === 'Smartphone' ? ' Ask the user to open Spotify on the phone, then try again.' : ''
    return `No device matches "${query}". ${seen}.${hint}`
  }
  return `"${query}" could be any of: ${ranked.map(deviceText).join(', ')}. Name one with --on.`
}

export class Spotify {
  private readonly auth: SpotifyAuth

  constructor(private readonly deps: SpotifyDeps = REAL_DEPS) {
    this.auth = new SpotifyAuth(deps.store, deps.fetch)
  }

  /** Run one command line, such as "play --on phone". Never rejects: every failure is a line saying what went wrong. */
  async run(args: string): Promise<string> {
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
    try {
      return await found.command.run(this, line, found.args)
    } catch (err) {
      if (err instanceof UsageError) return `spotify: ${err.message}\n\n${commandHelp(found.command)}`
      if (err instanceof SignInNeeded) {
        return `spotify: not signed in to Spotify (${err.message}). The user signs in once on the Mac by running "npm run spotify -- login" in the Spaceterm repo; an agent can do it for them.`
      }
      if (err instanceof SpotifyApiError) return `spotify ${found.command.name} failed: ${this.explain(err)}`
      return `spotify ${found.command.name} failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  private explain(err: SpotifyApiError): string {
    if (err.status === 403 && /premium/i.test(err.reason)) return 'Spotify says this needs Premium.'
    if (err.status === 403 && /scope/i.test(err.reason)) return `${err.message}. The sign-in lacks a permission; sign in again with "npm run spotify -- login".`
    if (err.status === 404) return `${err.message}. No device is active: name one with --on, or ask the user to open Spotify.`
    return err.message
  }

  async status(): Promise<string> {
    const state = await this.state()
    if (state) return stateText(state)
    return `${stateText(undefined)}. ${await this.devices()}`
  }

  async devices(): Promise<string> {
    const devices = await this.deviceList()
    if (!devices.length) return 'Spotify sees no devices. Spotify must be open on a device, such as the phone, for it to show up.'
    return `Spotify can play on:\n${devices.map((d) => `- ${deviceText(d)}${d.is_active ? ', active' : ''}${d.is_restricted ? ', cannot be controlled' : ''}`).join('\n')}`
  }

  async play(on: string | undefined): Promise<string> {
    if (on) {
      const device = await this.device(on)
      if (typeof device === 'string') return device
      await this.request('PUT', '/me/player', { body: { device_ids: [device.id], play: true } })
      return stateText(await this.settle((s) => s.device.id === device.id && s.is_playing))
    }
    const before = await this.state()
    if (!before) return `${stateText(undefined)}, so there is nothing to resume: use play --on <device>. ${await this.devices()}`
    if (before.is_playing) return `Already playing. ${stateText(before)}`
    await this.request('PUT', '/me/player/play')
    return stateText(await this.settle((s) => s.is_playing))
  }

  async pause(on: string | undefined): Promise<string> {
    const target = await this.target(on)
    if (typeof target === 'string') return target
    const before = await this.state()
    // Only the active device plays, so any other one is already paused.
    const pausedThere = !before?.is_playing || (target.id !== undefined && before.device.id !== target.id)
    if (pausedThere) return `Already paused. ${stateText(before)}`
    await this.request('PUT', '/me/player/pause', { query: target.id ? { device_id: target.id } : {} })
    return stateText(await this.settle((s) => !s.is_playing))
  }

  async next(on: string | undefined): Promise<string> {
    const target = await this.target(on)
    if (typeof target === 'string') return target
    const before = await this.state()
    await this.request('POST', '/me/player/next', { query: target.id ? { device_id: target.id } : {} })
    return stateText(await this.settle((s) => s.item?.uri !== before?.item?.uri))
  }

  async volume(percent: number, on: string | undefined): Promise<string> {
    let device: Device | undefined
    if (on) {
      const picked = await this.device(on)
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

  /** The device --on names (`id` undefined without --on), or why it names none. */
  private async target(on: string | undefined): Promise<{ id?: string } | string> {
    if (!on) return {}
    const device = await this.device(on)
    return typeof device === 'string' ? device : { id: device.id ?? undefined }
  }

  private async device(on: string): Promise<Device | string> {
    const picked = pickDevice(on, await this.deviceList())
    if (typeof picked !== 'string' && picked.is_restricted) return `${deviceText(picked)} does not let Spotify control it.`
    return picked
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
        throw new SpotifyApiError(res.status, reason)
      }
      return text ? JSON.parse(text) as T : undefined
    }
  }
}
