import { useEffect, useState } from 'react'

/**
 * Whether this phone is running older code than the Mac has: the page (a
 * build made since it loaded — a reload fixes it) or the native app around it
 * (a change made but never installed — only `npm run mobile:ios` fixes that).
 *
 * The server serves `build.json` beside the page, written by the build
 * (vite.config.ts): this build's id, and the native app's current version
 * (ios/native-version.mjs). The page knows its own id from the build, and the
 * app tells the page its version (WebViewController). Outside the app — in a
 * browser — there is no native version, and so nothing native to be behind.
 */

declare const __MOBILE_BUILD_ID__: string | undefined
declare global {
  interface Window { spacetermNativeVersion?: string }
}

export interface Versions { web?: string; native?: string }
export interface Staleness { web: boolean; native: boolean }

const CHECK_EVERY_MS = 10 * 60_000

/** What is behind, comparing what runs here with what the Mac publishes. Unknown is never behind. */
export function staleness(running: Versions, published: Versions): Staleness {
  const behind = (have?: string, latest?: string) => !!have && !!latest && have !== latest
  return { web: behind(running.web, published.web), native: behind(running.native, published.native) }
}

function running(): Versions {
  return {
    web: typeof __MOBILE_BUILD_ID__ === 'string' ? __MOBILE_BUILD_ID__ : undefined,
    native: window.spacetermNativeVersion
  }
}

async function published(): Promise<Versions | null> {
  try {
    const response = await fetch('build.json', { cache: 'no-store' })
    return response.ok ? (await response.json()) as Versions : null
  } catch {
    return null
  }
}

/** Checked on load, on coming back to the app, and every so often. */
export function useStaleness(): Staleness {
  const [stale, setStale] = useState<Staleness>({ web: false, native: false })
  useEffect(() => {
    let live = true
    const check = async () => {
      const latest = await published()
      if (!live || !latest) return
      const next = staleness(running(), latest)
      setStale((current) => current.web === next.web && current.native === next.native ? current : next)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    void check()
    const timer = setInterval(() => void check(), CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return stale
}
