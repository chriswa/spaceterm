import { useEffect, useRef, useState } from 'react'
import type { BrowserStatus, BrowserViewport } from '../../../../shared/browser'
import type { BrowserWatch } from '../../../../shared/browser-watches'
import type { NodeId } from '../../../../shared/ids'

/** What a card says over its page while there is no page to show. */
export function statusText(status: BrowserStatus | null, hasFrame: boolean): string | null {
  if (!status) return hasFrame ? null : 'Opening…'
  switch (status.kind) {
    case 'ready': return hasFrame ? null : 'Loading…'
    case 'connecting': return status.detail ?? (hasFrame ? null : 'Opening…')
    case 'unavailable': return status.reason
  }
}

/**
 * The frames of a card's page, and its status, for as long as `nodeId` is shown.
 * `live` asks for frames as fast as they are drawn.
 */
export function useBrowserFrames(nodeId: NodeId, opts: { live: boolean; scale: number; viewport?: BrowserViewport }) {
  const [frame, setFrame] = useState<{ src: string; width: number; height: number } | null>(null)
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const watchRef = useRef<BrowserWatch | null>(null)
  const optsKey = JSON.stringify(opts)

  useEffect(() => window.api.browser.onStatus(nodeId, setStatus), [nodeId])

  useEffect(() => {
    const watch = window.api.browser.watch(nodeId, JSON.parse(optsKey), async (next) => {
      const src = `data:image/jpeg;base64,${next.data}`
      // Decoded before it is shown and before the next is asked for, so frames never queue behind the decoder.
      const probe = new Image()
      probe.src = src
      await probe.decode?.().catch(() => undefined)
      setFrame({ src, width: next.width, height: next.height })
    })
    watchRef.current = watch
    return () => {
      watch.release()
      watchRef.current = null
    }
    // Watched once per card; option changes go through `update` below.
  }, [nodeId])

  useEffect(() => {
    watchRef.current?.update(JSON.parse(optsKey))
  }, [optsKey])

  return { frame, status, imgRef }
}
