import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from '@/lib/install-api'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { webSocketTransport, gatewayUrl } from './ws-transport'
import { browserPlatform } from './browser-platform'
import '@/styles/index.css'
import './mobile.css'

/**
 * The pairing token. Arrives once in the URL fragment — which a browser never
 * sends to any server — and is kept in this browser from then on.
 */
function takeToken(): string | null {
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token')
  try {
    if (fromHash) {
      localStorage.setItem('spaceterm.token', fromHash)
      history.replaceState(null, '', window.location.pathname + window.location.search)
      return fromHash
    }
    return localStorage.getItem('spaceterm.token')
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
  // `window.api` must exist before App's modules run, as on the desktop.
  void installApi(webSocketTransport(gatewayUrl(token)), browserPlatform(), 'spaceterm-mobile').then(async () => {
    const { MobileApp } = await import('./MobileApp')
    root.render(
      <StrictMode>
        <MobileApp />
      </StrictMode>
    )
  })
}
