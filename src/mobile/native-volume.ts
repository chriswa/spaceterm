import { isVolumeReading, type VolumeReading } from '../shared/device-volume'

/**
 * The phone's system volume, for Control's device_volume tool while this
 * phone holds Control. Only the iPhone app can reach it (`NativeVolume.swift`):
 * a web page can neither read nor set the system volume.
 *
 *   page → app:  `{}` to read, `{set: <0-100>}` to set and read back
 *   app → page:  `{percent}` or `{error}`
 */

interface ReplyingHandler {
  postMessage(message: unknown): Promise<unknown>
}

/** Longer than the app's own read-back wait, which is well under a second. */
const NATIVE_TIMEOUT_MS = 5_000

function handler(): ReplyingHandler | undefined {
  return window.webkit?.messageHandlers?.nativeVolume as ReplyingHandler | undefined
}

/** The page is inside the iPhone app, of whatever build: it always had a microphone handler. */
function insideApp(): boolean {
  return window.webkit?.messageHandlers?.nativeMicrophone !== undefined
}

export async function deviceVolume(set?: number): Promise<VolumeReading> {
  const h = handler()
  if (!h) {
    throw new Error(insideApp()
      ? 'the Spaceterm app on the phone was built before it could read or set the volume; install the iPhone app again'
      : 'the phone\'s volume can be read and set only from the Spaceterm iPhone app, not a web browser')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the iPhone app took too long to answer about its volume')), NATIVE_TIMEOUT_MS)
  })
  try {
    const answer = await Promise.race([h.postMessage(set === undefined ? {} : { set }), late])
    if (isVolumeReading(answer)) return { percent: Math.round(answer.percent) }
    const error = typeof answer === 'object' && answer !== null ? (answer as { error?: unknown }).error : undefined
    throw new Error(typeof error === 'string' ? error : 'the iPhone app gave no volume')
  } finally {
    clearTimeout(timer)
  }
}
