/**
 * A press shows the instant a finger lands, before anything it starts has
 * happened: the button sinks and brightens (`[data-pressed]`, mobile.css),
 * so a press that was taken is never mistaken for one that missed. What the
 * press then does — a microphone that takes seconds to start — shows after.
 *
 * Set on the element directly, from a `pointerdown` listener, rather than
 * through React or `:active`: WebKit applies `:active` on touch only with a
 * touch listener in place, and a React render can land a frame or more later.
 * Held at least `MIN_PRESSED_MS`, so a quick tap is still seen.
 */
export const MIN_PRESSED_MS = 150

export function installPressFeedback(root: Document | HTMLElement, selector: string, now: () => number = () => performance.now()): () => void {
  let pressed: { element: Element; at: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const release = () => {
    if (!pressed) return
    const { element, at } = pressed
    pressed = null
    const left = MIN_PRESSED_MS - (now() - at)
    const clear = () => element.removeAttribute('data-pressed')
    if (left > 0) timer = setTimeout(clear, left)
    else clear()
  }

  const down = (event: Event) => {
    const element = (event.target as Element | null)?.closest?.(selector)
    if (!element) return
    clearTimeout(timer)
    pressed?.element.removeAttribute('data-pressed')
    element.setAttribute('data-pressed', '')
    pressed = { element, at: now() }
  }

  const options = { capture: true, passive: true } as const
  root.addEventListener('pointerdown', down, options)
  for (const type of ['pointerup', 'pointercancel']) root.addEventListener(type, release, options)
  return () => {
    clearTimeout(timer)
    root.removeEventListener('pointerdown', down, options)
    for (const type of ['pointerup', 'pointercancel']) root.removeEventListener(type, release, options)
    pressed?.element.removeAttribute('data-pressed')
  }
}
