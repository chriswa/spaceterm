import { useEffect, useRef, useState } from 'react'
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
 * How long a new route must hold before the badge shows it. Opening the
 * microphone puts the page in play-and-record before the microphone is
 * running, and iOS routes that to the earpiece until AirPods' voice link is
 * up — 0.7–0.8 s in the log, with nothing playing — so without this the badge
 * flashes an ear on every press. A real change, AirPods put away, shows this
 * much later. The log (`audio-output`) records every route, settled or not.
 */
export const OUTPUT_SETTLE_MS = 1500

/** The current output, once it has settled; undefined in a browser and from an app too old to say. */
export function useAudioOutput(): NativeOutput | undefined {
  const [output, setOutput] = useState(nativeOutput)
  const shown = useRef(output)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (next: NativeOutput | undefined) => { shown.current = next; setOutput(next) }
    const stop = onNativeOutput((next) => {
      clearTimeout(timer)
      // The first route the app reports has nothing to hold in its place.
      if (shown.current === undefined) show(next)
      else timer = setTimeout(() => show(next), OUTPUT_SETTLE_MS)
    })
    return () => { clearTimeout(timer); stop() }
  }, [])
  return output
}
