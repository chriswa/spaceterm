import { useReceptionistStore, type ReceptionistState } from '@/stores/receptionistStore'
import { nativeDuckOthers } from './native-microphone'

/**
 * Other apps' audio — Spotify, say — turned down while Control thinks and
 * speaks aloud on this phone: the sonar, then its answer. The iPhone app
 * does the turning down (NativeMicrophone.swift `duck-others`), on the audio
 * session it keeps up while this phone holds Control. A dictation's own
 * microphone stops other audio outright, without asking, and the app keeps
 * it stopped a moment after, so a dictation flows into Control thinking
 * without the music swelling between. Nothing in a browser.
 *
 * Down at once; back up only once Control has been quiet for
 * `DUCK_RELEASE_MS`, so the gap between the sonar and the answer, or between
 * one answer and a follow-up, does not swell the music in between. Each
 * change costs the app a new audio session, which is its only way to duck.
 */
export const DUCK_RELEASE_MS = 1500

/** Control is busy where it is heard: held here, unmuted, and not ready. */
export function controlAudibleBusy(state: Pick<ReceptionistState, 'phase' | 'holder'>): boolean {
  return state.phase !== 'ready' && state.holder?.mine === true && !state.holder.muted
}

export function installDuckOthers(post: (on: boolean) => void = nativeDuckOthers): () => void {
  let on = false
  let release: ReturnType<typeof setTimeout> | undefined
  const follow = (state: ReceptionistState) => {
    const want = controlAudibleBusy(state)
    if (want) {
      clearTimeout(release)
      release = undefined
      if (!on) { on = true; post(true) }
    } else if (on && release === undefined) {
      release = setTimeout(() => { release = undefined; on = false; post(false) }, DUCK_RELEASE_MS)
    }
  }
  follow(useReceptionistStore.getState())
  const unsubscribe = useReceptionistStore.subscribe(follow)
  return () => {
    unsubscribe()
    clearTimeout(release)
    if (on) post(false)
  }
}
