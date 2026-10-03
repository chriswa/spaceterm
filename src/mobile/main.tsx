import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from '@/lib/install-api'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { webSocketTransport, gatewayUrl } from './ws-transport'
import { browserPlatform, forwardLogs } from './browser-platform'
import { startSpeechPlayer } from './speech-player'
import { initAudioSession } from './audio-session'
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
  // No bar along the bottom; the corner button opens the toolbar as a sheet.
  useSurfacePresenterStore.getState().setToolbarSheet(true)
  // `window.api` must exist before App's modules run, as on the desktop.
  void installApi(webSocketTransport(gatewayUrl(token)), browserPlatform(), 'spaceterm-mobile').then(async (client) => {
    forwardLogs((message) => client.clientLog(message))
    // Switching apps is when the phone's microphone and socket misbehave, so
    // the log marks each one.
    document.addEventListener('visibilitychange', () => window.api.log(`[lifecycle] page ${document.visibilityState}`))
    // Sound to the speaker, not the earpiece, except while recording.
    initAudioSession()
    // Summary Chat speaks here, not on the Mac (browserPlatform's playsSpeech).
    startSpeechPlayer(window.api.remoteSpeech, (message) => window.api.log(message))
    const { MobileApp } = await import('./MobileApp')
    root.render(
      <StrictMode>
        <MobileApp />
      </StrictMode>
    )
  })
}
