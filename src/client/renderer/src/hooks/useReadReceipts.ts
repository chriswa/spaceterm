import { useEffect, useRef, type RefObject } from 'react'

/**
 * Says a part of Control's reply was read once it has been on screen long
 * enough to have been: most of it in view for a second, in a page the user
 * is looking at. Seeing is not reading, but it is the evidence there is, and
 * it is what tells Control the user now knows what they had missed (see the
 * server's `ConsumptionLedger`).
 *
 * Watches every element in `listRef` marked `data-read-of` (the reply's
 * offset) and `data-read-part`, as they come and go. Each is reported once.
 */

/** How long a part must stay in view to count as read. */
export const READ_DWELL_MS = 1_000
/** How much of a part must be in view — or of the view, for a part taller than it. */
export const READ_VISIBLE = 0.6

/**
 * The dwell itself, apart from what it watches: `seen` as a part comes into
 * view or leaves it; `onRead` once one has stayed. Separate so it can be
 * tested without an IntersectionObserver.
 */
export class ReadDwell {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly reported = new Set<string>()

  constructor(private readonly onRead: (key: string) => void, private readonly dwellMs = READ_DWELL_MS) {}

  seen(key: string, visible: boolean): void {
    if (this.reported.has(key)) return
    const timer = this.timers.get(key)
    if (!visible) {
      clearTimeout(timer)
      this.timers.delete(key)
      return
    }
    if (timer !== undefined) return
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      this.reported.add(key)
      this.onRead(key)
    }, this.dwellMs))
  }

  /** Nothing is being looked at: the page is hidden, or the view closed. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

/** `[of, part]` as a dwell key, and back. */
const keyOf = (el: Element): string | undefined => {
  const of = (el as HTMLElement).dataset.readOf
  const part = (el as HTMLElement).dataset.readPart
  return of !== undefined && part !== undefined ? `${of}:${part}` : undefined
}

export function useReadReceipts(listRef: RefObject<HTMLElement>, onRead: (of: number, part: number) => void): void {
  const report = useRef(onRead)
  report.current = onRead
  useEffect(() => {
    const list = listRef.current
    if (!list || typeof IntersectionObserver === 'undefined') return
    const dwell = new ReadDwell((key) => {
      const [of, part] = key.split(':').map(Number)
      report.current(of, part)
    })
    const inView = new Map<string, boolean>()
    const observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const key = keyOf(record.target)
        if (!key) continue
        const view = record.rootBounds?.height ?? 0
        const visible = record.isIntersecting &&
          (record.intersectionRatio >= READ_VISIBLE || (view > 0 && record.intersectionRect.height >= view * READ_VISIBLE))
        inView.set(key, visible)
        if (document.visibilityState === 'visible') dwell.seen(key, visible)
      }
    }, { root: list, threshold: [0, READ_VISIBLE, 1] })
    const watched = new Set<Element>()
    const watch = () => {
      for (const el of list.querySelectorAll('[data-read-of]')) {
        if (watched.has(el)) continue
        watched.add(el)
        observer.observe(el)
      }
      for (const el of watched) {
        if (el.isConnected) continue
        watched.delete(el)
        observer.unobserve(el)
      }
    }
    watch()
    const mutations = new MutationObserver(watch)
    mutations.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-read-of'] })
    // A hidden page is read by nobody; back in front, what is in view starts again.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') { dwell.clear(); return }
      for (const [key, visible] of inView) dwell.seen(key, visible)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      mutations.disconnect()
      observer.disconnect()
      dwell.clear()
    }
  }, [listRef])
}
