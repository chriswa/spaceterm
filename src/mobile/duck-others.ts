import { useReceptionistStore, type ReceptionistState } from '@/stores/receptionistStore'
import { nativeDuckOthers, nativeHandsFreeDictating } from './native-microphone'
import { useHandsFree, type HandsFreePhase } from './hands-free'

/**
 * Other apps' audio — Spotify, say — turned down while Control thinks and
 * speaks aloud on this phone: the sonar, then its answer. The iPhone app
 * does the turning down (NativeMicrophone.swift `duck-others`), on the audio
 * session it keeps up while this phone holds Control. A dictation's own
 * microphone turns other audio down too, without asking, and the app keeps
 * it down a moment after, so a dictation flows into Control thinking
 * without the music swelling between. Nothing in a browser.
 *
 * Under hands-free the app leaves its session alone and turns music down
 * through voice processing instead, which it can do on the running
 * microphone, in the background too — only while hands-free takes a
 * dictation down (`followHandsFree`); Control's turns there leave it be.
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

/** Hands-free is taking a dictation down: from the words heard until they are sent. */
export function handsFreeDictating(phase: HandsFreePhase): boolean {
  return phase === 'hearing' || phase === 'sending'
}

/** Tell the app each time hands-free starts or stops taking a dictation down. */
export function followHandsFree(post: (on: boolean) => void = nativeHandsFreeDictating): () => void {
  let on = false
  return useHandsFree.subscribe(({ phase }) => {
    const want = handsFreeDictating(phase)
    if (want !== on) { on = want; post(want) }
  })
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
