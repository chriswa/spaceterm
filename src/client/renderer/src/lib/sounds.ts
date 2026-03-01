import type { SoundName } from '../../../../shared/protocol'
import doneSoundUrl from '../assets/sounds/done.mp3'
import errorSoundUrl from '../assets/sounds/error.mp3'

// Preload audio so playback is instant
const registry: Record<SoundName, HTMLAudioElement> = {
  done: Object.assign(new Audio(doneSoundUrl), { preload: 'auto' as const }),
  error: Object.assign(new Audio(errorSoundUrl), { preload: 'auto' as const }),
}
for (const a of Object.values(registry)) a.load()

/** Play a named sound. Resets to start if already playing. */
export function playSound(name: SoundName): void {
  const audio = registry[name]
  if (!audio) return
  audio.currentTime = 0
  audio.play().catch(() => {})
}
