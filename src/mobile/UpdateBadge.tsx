import { useState } from 'react'
import { useStaleness } from './update-check'

/**
 * A small mark in the top-left corner when this phone runs older code than
 * the Mac has (see update-check.ts). Tapping it reloads when the page is what
 * is behind; when the app is, it says how to install the new one — the phone
 * cannot do that for itself.
 */
export function UpdateBadge() {
  const stale = useStaleness()
  const [explaining, setExplaining] = useState(false)
  if (!stale.web && !stale.native) return null

  const onTap = () => {
    if (stale.web) window.location.reload()
    else setExplaining((e) => !e)
  }

  return (
    <>
      <button className="m-update" onClick={onTap} aria-label={stale.web ? 'A newer version is ready: reload' : 'This app needs reinstalling'}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
          <path d="M13.5 2.5v3h-3" />
        </svg>
        {stale.web ? 'Update' : 'App update'}
      </button>
      {explaining && (
        <div className="m-update__explain" onClick={() => setExplaining(false)}>
          The app on this phone is older than its source on the Mac. Install the new one from the Mac with
          <code>npm run mobile:ios</code>
        </div>
      )}
    </>
  )
}
