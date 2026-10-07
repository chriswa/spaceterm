import { useReceptionistStore } from '@/stores/receptionistStore'
import { keepAppAwake } from './native-microphone'

/**
 * Keep the iPhone app awake while this phone holds Control, so Control is
 * heard with the phone locked or another app in front (native-microphone.ts
 * `keepAppAwake`).
 *
 * Said only once the holder is known: the store starts empty, and a reload in
 * the background answering "nobody" before the server has would let the app
 * be suspended mid-reload. The app keeps the last answer until told otherwise.
 */
export function installStayAwake(): () => void {
  return useReceptionistStore.subscribe((state, prev) => {
    if (state.holder !== prev.holder) keepAppAwake(state.holder?.mine === true)
  })
}
