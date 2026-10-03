import { useState } from 'react'
import { useStaleness } from './update-check'

/**
 * A small mark in the top-left corner when this phone runs older code than
 * the Mac has (see update-check.ts). Tapping it brings the phone up to date:
 * a newer page is a reload; a newer app is built and installed by the Mac
 * (src/server/mobile-install.ts), which replaces this app and relaunches it —
 * so success is the app restarting, and only a failure is ever shown here.
 * The app comes first when both are behind: the new app loads the new page.
 */
export function UpdateBadge() {
  const stale = useStaleness()
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!stale.web && !stale.native) return null

  const onTap = async () => {
    if (!stale.native) {
      window.location.reload()
      return
    }
    if (installing) return
    setFailure(null)
    setInstalling(true)
    try {
      const outcome = await window.api.installMobileApp()
      if (!outcome.ok) setFailure(outcome.message ?? 'The install failed.')
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const label = installing ? 'Installing…' : stale.native ? 'App update' : 'Reload'
  return (
    <>
      <button
        className={`m-update${installing ? ' m-update--busy' : ''}`}
        onClick={() => void onTap()}
        aria-label={stale.native ? 'Install the newer app from the Mac' : 'A newer version is ready: reload'}
        aria-busy={installing}
      >
        <svg className="m-update__icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2.5v3h-3" />
        </svg>
        {label}
      </button>
      {failure && (
        <div className="m-update__failure" role="alert" onClick={() => setFailure(null)}>
          {failure}
        </div>
      )}
    </>
  )
}
