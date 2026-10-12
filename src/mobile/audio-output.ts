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

/** The current output, or undefined in a browser and from an app too old to say. */
export function useAudioOutput(): NativeOutput | undefined {
  const [output, setOutput] = useState(nativeOutput)
  useEffect(() => onNativeOutput(setOutput), [])
  return output
}
