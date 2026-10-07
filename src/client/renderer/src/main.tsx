import { installSupersample, isSupersampleActive, realDevicePixelRatio } from './lib/supersample'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from './lib/install-api'
import { electronTransport } from './lib/electron-transport'
import { installDesktopMemoryProbe } from './lib/page-memory'
import { DESKTOP_DEVICE } from '../../../shared/state'
import './styles/index.css'

// First, so xterm and every canvas read the overridden pixel ratio.
installSupersample()

const host = window.electronHost

// `window.api` must exist before App's modules run, so App is imported only
// once it has been installed.
void installApi(electronTransport(host.pipe), host.platform, 'spaceterm-electron', { id: DESKTOP_DEVICE.deviceId, label: DESKTOP_DEVICE.label }).then(async () => {
  installDesktopMemoryProbe(message => window.api.log(message))
  window.api.log(`[Supersample] display ratio ${realDevicePixelRatio()}, ${isSupersampleActive() ? 'on' : 'off'}`)
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
