import { useEffect, useState } from 'react'
import { nativeOutput, onNativeOutput, type NativeOutput } from './native-microphone'

/**
 * Where the phone's sound is going, as the iPhone app reports it — for the
 * badge on the microphone button. iOS routes it: to AirPods or other
 * headphones while they are connected, else to the speaker. Nothing here
 * chooses; the badge is there so a wrong route can be seen.
 */
export type OutputKind = 'speaker' | 'earpiece' | 'headphones' | 'other'

/** An AVAudioSession port type, e.g. "Speaker", "Receiver", "BluetoothA2DPOutput", as a kind of output. */
export function outputKind(portType: string): OutputKind {
  if (portType === 'Speaker') return 'speaker'
  if (portType === 'Receiver') return 'earpiece'
  if (/^Bluetooth|^Headphones$/.test(portType)) return 'headphones'
  return 'other'
}

/**
 * How long the earpiece must last before the badge shows it. AirPods switching
 * from their music link to their microphone link — every time a microphone
 * opens — pass through the earpiece for a second or so on the way (October 25:
 * 0.7–2 s), which flashed the ear on the badge while nothing was wrong.
 */
export const EARPIECE_SETTLE_MS = 2500

/**
 * Follow the output, the earpiece only once it has stayed: `subscribe` as
 * `onNativeOutput`, `show` as a state setter. Returns a way to stop.
 */
export function followOutput(
  subscribe: (fn: (output: NativeOutput | undefined) => void) => () => void,
  show: (output: NativeOutput | undefined) => void,
  settleMs = EARPIECE_SETTLE_MS,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const off = subscribe((output) => {
    clearTimeout(timer)
    timer = undefined
    if (output && outputKind(output.type) === 'earpiece') timer = setTimeout(() => show(output), settleMs)
    else show(output)
  })
  return () => {
    clearTimeout(timer)
    off()
  }
}

/** The current output, or undefined in a browser and from an app too old to say. */
export function useAudioOutput(): NativeOutput | undefined {
  const [output, setOutput] = useState(nativeOutput)
  useEffect(() => followOutput(onNativeOutput, setOutput), [])
  return output
}
