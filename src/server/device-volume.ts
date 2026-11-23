import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import type { VolumeReading } from '../shared/device-volume'

/**
 * Control's device_volume tool: the system volume of the device the user is
 * talking to Control from — the phone or the Mac holding Control. This is
 * the device's own volume, which everything on it plays through; Spotify's
 * volume is a separate one, inside Spotify (spotify/index.ts).
 *
 * - **The Mac**: the server runs on it, so it asks macOS itself, through
 *   AppleScript's `volume settings`. Electron has no system-volume API, and a
 *   CoreAudio call would need a native module for the same two numbers.
 * - **A phone**: only the iPhone app can reach the system volume, so the
 *   server asks the holder's client (`device-volume-request`), which asks the
 *   app (native-volume.ts, NativeVolume.swift). `PhoneVolumeRequests` matches
 *   the answers to the questions.
 */

/** Where Control is held, as device_volume needs it. */
export type VolumeTarget =
  | { kind: 'mac' }
  | { kind: 'phone'; label: string; ask(set: number | undefined): Promise<VolumeReading> }
  /** No device to ask, and why, worded for the user. */
  | { kind: 'unavailable'; reason: string }

export interface MacVolumeProbes {
  /** Run one AppleScript; its output as printed. */
  osascript(script: string): Promise<string>
}

const OSASCRIPT_TIMEOUT_MS = 5_000

export const REAL_MAC_VOLUME_PROBES: MacVolumeProbes = {
  osascript: (script) => new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: OSASCRIPT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error(`could not run osascript: ${String(stderr).trim() || err.message}`))
      else resolve(stdout)
    })
  }),
}

/**
 * `get volume settings` as osascript prints it:
 * "output volume:25, input volume:50, alert volume:100, output muted:true".
 * An output with no volume of its own (HDMI, some USB devices) prints
 * "output volume:missing value".
 */
export function parseVolumeSettings(printed: string): VolumeReading {
  const field = (name: string) => new RegExp(`${name}:([^,]+)`).exec(printed)?.[1]?.trim()
  const volume = field('output volume')
  if (volume === 'missing value') throw new Error('the Mac\'s current sound output has no volume of its own; it is set on the speaker or display itself')
  const percent = Number(volume)
  if (volume === undefined || !Number.isFinite(percent)) throw new Error(`macOS gave its volume as "${printed.trim()}", which could not be read`)
  const muted = field('output muted')
  return { percent: Math.round(percent), ...(muted === 'true' || muted === 'false' ? { muted: muted === 'true' } : {}) }
}

export async function readMacVolume(probes: MacVolumeProbes = REAL_MAC_VOLUME_PROBES): Promise<VolumeReading> {
  return parseVolumeSettings(await probes.osascript('get volume settings'))
}

/** Sets the Mac's output volume and unmutes it — asking for a volume is asking to hear it — then reads it back. */
export async function setMacVolume(percent: number, probes: MacVolumeProbes = REAL_MAC_VOLUME_PROBES): Promise<VolumeReading> {
  await probes.osascript(`set volume output volume ${percent} without output muted`)
  return readMacVolume(probes)
}

function describeReading(reading: VolumeReading): string {
  return `${reading.percent}%${reading.muted ? ', muted' : ''}`
}

/**
 * What device_volume tells the model: `set` undefined reads the volume,
 * a number from 0 to 100 sets it. Never rejects.
 */
export async function deviceVolume(target: VolumeTarget, set: number | undefined, mac: MacVolumeProbes = REAL_MAC_VOLUME_PROBES): Promise<string> {
  if (target.kind === 'unavailable') return `device_volume could not reach a device: ${target.reason}.`
  const whose = target.kind === 'mac' ? 'the Mac\'s system volume' : `the phone's system volume (${target.label})`
  try {
    if (set === undefined) {
      const reading = target.kind === 'mac' ? await readMacVolume(mac) : await target.ask(undefined)
      return `device_volume: ${whose} is ${describeReading(reading)}.`
    }
    const before = target.kind === 'mac' ? await readMacVolume(mac).catch(() => undefined) : undefined
    const after = target.kind === 'mac' ? await setMacVolume(set, mac) : await target.ask(set)
    const unmuted = before?.muted === true && after.muted === false ? ', and it is no longer muted' : ''
    return `device_volume set ${whose} to ${describeReading(after)}${unmuted}.`
  } catch (err) {
    return `device_volume could not ${set === undefined ? 'read' : 'set'} ${whose}: ${err instanceof Error ? err.message : String(err)}.`
  }
}

/** Longer than the page's own limit on the app (native-volume.ts), so its reason arrives first. */
export const PHONE_VOLUME_DEADLINE_MS = 8_000

export interface PhoneVolumeDeps {
  /** Send `device-volume-request` to one client. */
  send(clientId: string, requestId: string, set: number | undefined): void
  /** Run `fn` after `ms`; returns a cancel. Defaults to `setTimeout`. */
  schedule?(ms: number, fn: () => void): () => void
}

const REAL_SCHEDULE = (ms: number, fn: () => void): (() => void) => {
  const timer = setTimeout(fn, ms)
  return () => clearTimeout(timer)
}

interface Pending {
  clientId: string
  settle(result: VolumeReading | Error): void
}

/** The phone round trips: each request waits for its own client's answer, a disconnect, or the deadline. */
export class PhoneVolumeRequests {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly deps: PhoneVolumeDeps) {}

  ask(clientId: string, set: number | undefined, deadlineMs = PHONE_VOLUME_DEADLINE_MS): Promise<VolumeReading> {
    const requestId = randomUUID()
    return new Promise<VolumeReading>((resolve, reject) => {
      let cancel = (): void => {}
      const settle = (result: VolumeReading | Error): void => {
        if (!this.pending.delete(requestId)) return
        cancel()
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      this.pending.set(requestId, { clientId, settle })
      cancel = (this.deps.schedule ?? REAL_SCHEDULE)(deadlineMs, () => settle(new Error('the phone did not answer in time')))
      this.deps.send(clientId, requestId, set)
    })
  }

  /** A client's `device-volume-reply`. One from another client, or for a request already settled, is ignored. */
  answer(clientId: string, requestId: string, answer: VolumeReading | Error): void {
    const request = this.pending.get(requestId)
    if (request?.clientId === clientId) request.settle(answer)
  }

  /** A client went away: it will not answer anything it was asked. */
  disconnected(clientId: string): void {
    for (const request of [...this.pending.values()]) {
      if (request.clientId === clientId) request.settle(new Error('the phone disconnected before answering'))
    }
  }
}
