import { useEffect, useState, type ReactNode } from 'react'
import { useRestartRequiredStore } from '@/stores/restartRequiredStore'
import { useStaleness } from './update-check'

/**
 * Whatever is waiting to bring the phone and the Mac up to date, as one chip
 * on the bottom bar beside the rocket: gone when nothing is, showing the first
 * thing to do when something is, with a count when there is more than one.
 * A tap lists them, each with its own button.
 *
 * - **Restart the server** — an agent flagged one (`npm run flag-restart`;
 *   restartRequiredStore). The fresh server clears the flag.
 * - **Install the app** — the Mac has a newer native app than this one
 *   (update-check.ts). The Mac builds and installs it
 *   (src/server/mobile-install.ts), which replaces this app and relaunches
 *   it, so success is the app restarting, and only a failure is shown here.
 * - **Reload** — the Mac rebuilt the page since this one loaded. Not offered
 *   while the app is behind: the new app loads the new page.
 *
 * In that order: a restarted server may build a newer page, so reloading
 * first could mean reloading twice.
 */

export type UpdateKind = 'restart' | 'install' | 'reload'

/** How long a restarted server may take before the button stops saying it is restarting. */
const RESTART_PATIENCE_MS = 60_000

export function pendingUpdates(state: { restart: boolean; native: boolean; web: boolean }): UpdateKind[] {
  const kinds: UpdateKind[] = []
  if (state.restart) kinds.push('restart')
  if (state.native) kinds.push('install')
  else if (state.web) kinds.push('reload')
  return kinds
}

const ICONS: Record<UpdateKind, ReactNode> = {
  // A server: two stacked units.
  restart: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" strokeWidth="2.2" />
    </>
  ),
  // Down into a tray.
  install: (
    <>
      <path d="M8 2.5v7.5" />
      <path d="M4.75 7 8 10.25 11.25 7" />
      <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
    </>
  ),
  // Round again.
  reload: (
    <>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3h-3" />
    </>
  )
}

function Icon({ kind, size }: { kind: UpdateKind; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[kind]}
    </svg>
  )
}

export function UpdatesButton() {
  const stale = useStaleness()
  const restart = useRestartRequiredStore((s) => s.required)
  const reason = useRestartRequiredStore((s) => s.reason)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<UpdateKind | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const kinds = pendingUpdates({ restart, native: stale.native, web: stale.web })

  // The last one done: nothing left to list.
  useEffect(() => {
    if (kinds.length === 0) setOpen(false)
  }, [kinds.length])

  if (kinds.length === 0) return null

  /**
   * Busy from the tap until the thing is done — which for all three is this
   * page going away: reloaded, reloaded once the restarted server is back
   * (install-api), or replaced with the new app. Clearing it when the Mac
   * merely accepted a restart put the button back to "Restart" while the
   * server was still going down, so a tap looked like it had done nothing.
   */
  const run = async (kind: UpdateKind) => {
    if (busy) return
    setFailure(null)
    setBusy(kind)
    if (kind === 'reload') {
      // Two frames: "Reloading…" is painted before the page goes.
      requestAnimationFrame(() => requestAnimationFrame(() => window.location.reload()))
      return
    }
    try {
      if (kind === 'restart') {
        await window.api.restartSpaceterm()
        window.setTimeout(() => {
          setBusy((current) => (current === 'restart' ? null : current))
          setFailure('The server has not come back yet.')
        }, RESTART_PATIENCE_MS)
        return
      }
      const outcome = await window.api.installMobileApp()
      if (outcome.ok) return
      setFailure(outcome.message ?? 'The install failed.')
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    }
    setBusy(null)
  }

  const rows: Record<UpdateKind, { title: string; detail: string; action: string; doing: string }> = {
    restart: { title: 'Server restart needed', detail: reason || 'Flagged by an agent', action: 'Restart', doing: 'Restarting…' },
    install: { title: 'App update', detail: 'Built on the Mac, not yet on this phone', action: 'Install', doing: 'Installing…' },
    reload: { title: 'Newer page', detail: 'Rebuilt since this one loaded', action: 'Reload', doing: 'Reloading…' }
  }

  return (
    <>
      <button
        className={`m-bar__button m-updates${busy ? ' m-updates--busy' : ''}`}
        aria-label={kinds.map((k) => rows[k].title).join(', ')}
        aria-expanded={open}
        aria-busy={busy !== null}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon kind={kinds[0]} size={20} />
        {kinds.length > 1 && <span className="m-updates__count" aria-hidden="true">{kinds.length}</span>}
      </button>
      {open && (
        <>
          <div className="m-updates__scrim" onClick={() => setOpen(false)} />
          <div className="m-updates__panel" role="dialog" aria-label="Updates">
            {kinds.map((kind) => (
              <button key={kind} className={`m-updates__row${busy === kind ? ' m-updates__row--busy' : ''}`} disabled={busy !== null} onClick={() => void run(kind)}>
                <span className="m-updates__icon"><Icon kind={kind} size={18} /></span>
                <span className="m-updates__text">
                  <span className="m-updates__title">{rows[kind].title}</span>
                  <span className="m-updates__detail">{rows[kind].detail}</span>
                </span>
                <span className="m-updates__action">
                  {busy === kind && <span className="m-updates__spinner" aria-hidden="true" />}
                  {busy === kind ? rows[kind].doing : rows[kind].action}
                </span>
              </button>
            ))}
            {failure && <div className="m-updates__failure" role="alert">{failure}</div>}
          </div>
        </>
      )}
    </>
  )
}
