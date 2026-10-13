import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from '@/lib/install-api'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { deferCameraScaleWhileMoving } from '@/hooks/useCamera'
import { webSocketTransport, gatewayUrl } from './ws-transport'
import { browserPlatform, forwardLogs, canvasOnScreen } from './browser-platform'
import { controlModeGate, installControlMode } from './control-mode'
import { canvasLifecycle, lastView, rememberView } from './canvas-lifecycle'
import { retainServerSync } from '@/lib/server-sync'
import { useControlTranscriptStore } from '@/stores/controlTranscriptStore'
import { useClientStalenessStore } from '@/stores/clientStalenessStore'
import { PageWork, meteredTransport, installPageWorkReport } from './page-work'
import { not } from './gate'
import { installDiagnostics } from './diagnostics'
import { installMemoryProbe } from './memory-probe'
import { startSpeechPlayer } from './speech-player'
import { initAudioSession } from './audio-session'
import { installHeldMicrophone, onHoldStateChange } from './held-microphone'
import { installStayAwake } from './stay-awake'
import { followHandsFree, installDuckOthers } from './duck-others'
import { DownlinkWatch, watchedTransport } from './downlink-watch'
import { installHandsFree, useHandsFree } from './hands-free'
import { installControlTones } from './control-tones'
import { playCue, playHandsFreeCue } from './cues'
import { installReadyCue } from './ready-cue'
import { Dictation } from './dictation'
import { useDictationSession } from './dictation-session'
import { thinkingCueScope } from '@/lib/thinking-cue'
import { phoneDevice } from './device'
import { mobileEvents, recordMobileEvent } from './mobile-events'
import { installLifecycleEvents, installNativeEventBridge } from './lifecycle-events'
import { recoverCameraAfterKill } from './crash-camera'
import '@/styles/index.css'
import './mobile.css'

/**
 * The pairing token. Arrives in the URL fragment — which a browser never sends
 * to any server — and is kept there as well as in this browser's storage.
 *
 * Kept in the URL deliberately: iOS gives a home-screen web app storage of its
 * own, separate from the browser it was added from, so "Add to Home Screen"
 * must save a URL that still carries the token or the app opens unpaired.
 */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token')
  try {
    if (fromHash) {
      localStorage.setItem('spaceterm.token', fromHash)
      return fromHash
    }
    const stored = localStorage.getItem('spaceterm.token')
    if (stored) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#token=${encodeURIComponent(stored)}`)
    return stored
  } catch {
    return fromHash
  }
}

const root = createRoot(document.getElementById('root')!)
const token = takeToken()

if (!token) {
  root.render(
    <div className="mobile-pairing">
      <h1>Spaceterm</h1>
      <p>Open the pairing link from your Mac once — it carries the key this phone needs.</p>
      <pre>npm run mobile:link</pre>
    </div>
  )
} else {
  // Before anything renders: the canvas must never mount a live terminal in a card.
  useSurfacePresenterStore.getState().setExternal(true)
  // A fresh start opens on Control's transcript, with no canvas; a reload goes
  // back to whichever it was on. See canvas-lifecycle.ts.
  const startView = lastView()
  if (startView === 'control') useControlTranscriptStore.getState().setOpen(true)
  useControlTranscriptStore.subscribe((s, prev) => {
    if (s.open !== prev.open) rememberView(s.open ? 'control' : 'canvas')
  })
  // A zoom scales the cards as drawn and redraws them once it settles: redrawn
  // at every scale, a zoom-out ran WebKit out of memory. See useCamera.
  deferCameraScaleWhileMoving(true)
  // No bar along the bottom; the corner button opens the toolbar as a sheet.
  useSurfacePresenterStore.getState().setToolbarSheet(true)
  // The audio and lifecycle record keeps what happens before the server is
  // reached, and sends it once it is; the app may send its own from now on.
  installNativeEventBridge()
  installLifecycleEvents()
  // `window.api` must exist before App's modules run, as on the desktop.
  // What the page is sent and spends on it, reported once a minute; see page-work.ts.
  const work = new PageWork()
  // The socket's life and every gap in what the Mac sends, for the record; see downlink-watch.ts.
  const downlink = new DownlinkWatch({ record: recordMobileEvent, visible: () => document.visibilityState === 'visible' })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') downlink.shown() })
  void installApi(meteredTransport(watchedTransport(webSocketTransport(gatewayUrl(token)), downlink), work), browserPlatform(), 'spaceterm-mobile', phoneDevice()).then(async (client) => {
    forwardLogs((message) => client.clientLog(message))
    // The stores everything here reads — the nodes, Control's, the restart
    // flag — kept current for the page's whole life, not only while the
    // canvas is mounted. Never released.
    retainServerSync()
    // A launch starts with Control let go, as with the held microphone: the
    // server keeps a phone's hold while it is away, but not across a relaunch.
    // Only a launch, not a reconnect — those keep it. A mute is kept.
    if (client.isConnected()) client.holdReceptionist('release')
    else {
      const off = client.onLifecycle('connect', () => { off(); client.holdReceptionist('release') })
    }
    mobileEvents.setSender((events) => client.mobileEvents(events))
    // Whether this app needs installing again, for Control to say: on every
    // connect, since a restarted server has forgotten, and on every change.
    client.onLifecycle('connect', () => client.appBehind(useClientStalenessStore.getState().native))
    if (client.isConnected()) client.appBehind(useClientStalenessStore.getState().native)
    useClientStalenessStore.subscribe((s, prev) => { if (s.native !== prev.native) client.appBehind(s.native) })
    recordMobileEvent('server', { connected: true })
    client.onLifecycle('disconnect', () => recordMobileEvent('server', { connected: false }))
    client.onLifecycle('connect', () => {
      recordMobileEvent('server', { connected: true })
      mobileEvents.flush()
    })
    // Switching apps is when the phone's microphone and socket misbehave, so
    // the log marks each one.
    document.addEventListener('visibilitychange', () => window.api.log(`[lifecycle] page ${document.visibilityState}`))
    // Only talking to Control — its transcript up, or the screen off: the
    // canvas stops, and so does the server's stream of it. See control-mode.ts.
    const controlMode = controlModeGate()
    installControlMode(controlMode, {
      pauseCanvas: (paused) => window.api.node.pauseCanvas(paused),
      log: (message) => window.api.log(message),
      record: recordMobileEvent,
    })
    installPageWorkReport({ work, controlMode, record: recordMobileEvent })
    // After installControlMode, so leaving Control mode resumes the server's
    // snapshots before the canvas's cards mount and ask for theirs.
    const canvasMounted = canvasLifecycle({
      controlMode,
      startMounted: startView === 'canvas',
      log: (message) => window.api.log(message),
    })
    canvasMounted.subscribe((mounted) => recordMobileEvent('canvas', { mounted }))
    installDiagnostics((message) => window.api.log(message), not(controlMode))
    installMemoryProbe((message) => window.api.log(message), Boolean(window.spacetermProcessRestarts), canvasOnScreen)
    // Not back where it ran out of memory, or it runs out again: see crash-camera.ts.
    const recovered = recoverCameraAfterKill(window.spacetermProcessRestarts ?? 0)
    if (recovered) window.api.log(recovered)
    // Sound to the speaker, not the earpiece, except while recording.
    initAudioSession()
    installHeldMicrophone()
    // Control heard with the phone locked: the app stays awake while this phone holds it.
    installStayAwake()
    installDuckOthers()
    followHandsFree()
    // Listens for "Control" on the held microphone; see hands-free.ts.
    installHandsFree(window.api)
    // A tone as the hands-free switch turns white: ready to listen.
    installReadyCue(onHoldStateChange, () => playHandsFreeCue('handsFreeReady'))
    // The sonar carries on while Control's voice is made, and its turns end
    // with a tone when it says nothing or fails — where replies are Aloud.
    thinkingCueScope.alsoSynthesizing = true
    installControlTones({
      play: playCue,
      userTalking: () => Dictation.live > 0 || useDictationSession.getState().mic.kind !== 'idle'
        || useHandsFree.getState().phase === 'hearing' || useHandsFree.getState().phase === 'sending',
      now: () => performance.now(),
    })
    // Control speaks here, not on the Mac, while this phone holds it.
    startSpeechPlayer(window.api.remoteSpeech, (message) => window.api.log(message))
    const { MobileApp } = await import('./MobileApp')
    root.render(
      <StrictMode>
        <MobileApp canvasMounted={canvasMounted} />
      </StrictMode>
    )
  })
}
