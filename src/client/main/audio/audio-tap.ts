import type { AudioTee, AudioChunk } from 'audiotee'
import * as logger from '../logger'

const loadAudioTee = () => import('audiotee')

let tap: AudioTee | null = null
let dataCallback: ((chunk: AudioChunk) => void) | null = null

export function onData(cb: (chunk: AudioChunk) => void): void {
  dataCallback = cb
}

export async function start(): Promise<void> {
  if (tap) return
  try {
    const { AudioTee } = await loadAudioTee()
    tap = new AudioTee({
      sampleRate: 44100,
      chunkDurationMs: 50,
      mute: false
    })

    tap.on('data', (chunk) => {
      dataCallback?.(chunk)
    })

    tap.on('error', (err) => {
      logger.log(`[audio-tap] error: ${err.message}`)
    })

    tap.on('log', (level, message) => {
      logger.log(`[audio-tap] ${level}: ${message.message}`)
    })

    await tap.start()
    logger.log('[audio-tap] started')
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.log(`[audio-tap] failed to start: ${msg}`)
    tap = null
  }
}

export async function stop(): Promise<void> {
  if (!tap) return
  try {
    await tap.stop()
  } catch {
    // ignore stop errors
  }
  tap = null
  dataCallback = null
  logger.log('[audio-tap] stopped')
}

export function isRunning(): boolean {
  return tap?.isActive() ?? false
}
