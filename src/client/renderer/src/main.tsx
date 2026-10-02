import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installApi } from './lib/install-api'
import { electronTransport } from './lib/electron-transport'
import './styles/index.css'

const host = window.electronHost

// `window.api` must exist before App's modules run, so App is imported only
// once it has been installed.
void installApi(electronTransport(host.pipe), host.platform, 'spaceterm-electron').then(async () => {
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
