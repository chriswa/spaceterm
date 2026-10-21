import { useEffect, useRef, useState } from 'react'
import type { ControlImage } from '../../../../shared/protocol'
import { GESTURE_OWNER_ATTR } from '../lib/gesture-owner'
import { FITTED, panBy, pinch, zoomAbout, type Frame, type PanZoom, type Point } from '../lib/pan-zoom'
import './ControlImages.css'

/**
 * Pictures an agent showed the user in Control's transcript
 * (`show_user_images`): a row of small copies, and one opened over the
 * transcript at full size on a tap. The server keeps the pictures; this asks
 * for each as it is drawn (`receptionist.image`), the small copy for the row
 * and the whole picture only once it is opened — on the phone, decoding a
 * dozen full screenshots at once is what gets a page killed for memory.
 */

/** Small copies already fetched, by id: a transcript reopened or scrolled back draws them at once. Small, and few. */
const thumbs = new Map<string, Promise<string>>()

function fetchUrl(id: string, size: 'thumb' | 'full'): Promise<string> {
  return window.api.receptionist.image(id, size).then(({ mime, data }) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: mime }))
  })
}

function thumbUrl(id: string): Promise<string> {
  let url = thumbs.get(id)
  if (!url) {
    url = fetchUrl(id, 'thumb')
    // A failure is not kept: the next drawing asks again.
    url.catch(() => thumbs.delete(id))
    thumbs.set(id, url)
  }
  return url
}

/** The picture's URL once fetched, `null` while it is on its way, or the reason it could not be. */
function useImageUrl(id: string, size: 'thumb' | 'full'): string | null | { error: string } {
  const [url, setUrl] = useState<string | null | { error: string }>(null)
  useEffect(() => {
    let live = true
    let owned: string | undefined
    setUrl(null)
    const fetching = size === 'thumb' ? thumbUrl(id) : fetchUrl(id, 'full')
    fetching.then((got) => {
      // The whole picture is this view's alone, and let go with it.
      if (size === 'full') owned = got
      if (live) setUrl(got)
      else if (owned) URL.revokeObjectURL(owned)
    }, (err: unknown) => {
      if (live) setUrl({ error: err instanceof Error ? err.message : String(err) })
    })
    return () => {
      live = false
      if (owned) URL.revokeObjectURL(owned)
    }
  }, [id, size])
  return url
}

function Thumb({ image, onOpen }: { image: ControlImage; onOpen: () => void }) {
  const url = useImageUrl(image.id, 'thumb')
  return (
    <figure className="control-images__item">
      <button className="control-images__thumb" onClick={onOpen} aria-label={image.caption ? `Open ${image.caption}` : 'Open the picture'}>
        {typeof url === 'string'
          ? <img src={url} alt={image.caption ?? ''} />
          : <span className="control-images__placeholder">{url ? 'Not kept' : ''}</span>}
      </button>
      {image.caption && <figcaption>{image.caption}</figcaption>}
    </figure>
  )
}

/** Further than this between press and release, a press on the picture is a drag rather than a tap. */
const TAP_SLOP_PX = 8

/** A pointer's position from the centre of `el`. */
function fromCentre(el: Element, e: { clientX: number; clientY: number }): Point {
  const rect = el.getBoundingClientRect()
  return { x: e.clientX - (rect.left + rect.width / 2), y: e.clientY - (rect.top + rect.height / 2) }
}

/** The fitted picture and its stage, measured now: layout sizes, which its transform does not change. */
function measure(stage: HTMLElement | null, img: HTMLImageElement | null): Frame | undefined {
  if (!stage || !img || !img.offsetWidth) return undefined
  return { width: img.offsetWidth, height: img.offsetHeight, frameWidth: stage.clientWidth, frameHeight: stage.clientHeight }
}

/**
 * Pinch and drag on the stage, and on the Mac a trackpad pinch (or Command
 * and the wheel) to zoom and a scroll to move about. The stage is marked as
 * owning its gestures, so none of them closes the transcript, and a scroll
 * stops here rather than reaching the canvas underneath.
 *
 * Returns whether the press just released was a drag, for the click that
 * follows it to be ignored.
 */
function usePanZoom(stageRef: React.RefObject<HTMLDivElement>, imgRef: React.RefObject<HTMLImageElement>, setView: React.Dispatch<React.SetStateAction<PanZoom>>) {
  const pointers = useRef(new Map<number, { start: Point; at: Point }>())
  const dragged = useRef(false)

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const frame = measure(stage, imgRef.current)
      if (!frame) return
      const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (e.ctrlKey || e.metaKey) {
        const at = fromCentre(stage, e)
        setView((view) => zoomAbout(view, Math.exp(-e.deltaY * px * 0.01), at, frame))
      } else {
        setView((view) => panBy(view, -e.deltaX * px, -e.deltaY * px, frame))
      }
    }
    // Followed on the window, not captured to the stage: a captured press
    // would make its click the stage's, and a tap on the picture would close it.
    const onMove = (e: PointerEvent) => {
      const moving = pointers.current.get(e.pointerId)
      if (!moving) return
      const before = moving.at
      const after = fromCentre(stage, e)
      moving.at = after
      if (Math.hypot(after.x - moving.start.x, after.y - moving.start.y) > TAP_SLOP_PX) dragged.current = true
      const frame = measure(stage, imgRef.current)
      if (!frame) return
      const other = [...pointers.current.entries()].find(([id]) => id !== e.pointerId)?.[1]
      if (other) setView((view) => pinch(view, [before, other.at], [after, other.at], frame))
      else setView((view) => panBy(view, after.x - before.x, after.y - before.y, frame))
    }
    const onEnd = (e: PointerEvent) => { pointers.current.delete(e.pointerId) }
    stage.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      stage.removeEventListener('wheel', onWheel)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [stageRef, imgRef, setView])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // A second finger makes it a pinch, never a tap.
    dragged.current = pointers.current.size > 0
    const at = fromCentre(e.currentTarget, e)
    pointers.current.set(e.pointerId, { start: at, at })
  }
  const onClickCapture = (e: React.MouseEvent) => {
    if (dragged.current) e.stopPropagation()
  }
  return { onPointerDown, onClickCapture }
}

/**
 * One picture over the whole window, fitted to it. Pinch, or a trackpad
 * pinch, zooms it and a drag or scroll moves it about; a tap on it zooms to
 * its own size and back, and a tap outside it, or Escape, closes it. Inside
 * the transcript's dialog, so a press on it is not a press outside the dialog
 * that closes the transcript.
 */
function Viewer({ images, at, onMove, onClose }: { images: ControlImage[]; at: number; onMove: (to: number) => void; onClose: () => void }) {
  const image = images[at]
  const url = useImageUrl(image.id, 'full')
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const [view, setView] = useState<PanZoom>(FITTED)
  useEffect(() => setView(FITTED), [at])
  const gestures = usePanZoom(stageRef, imgRef, setView)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && at < images.length - 1) onMove(at + 1)
      else if (e.key === 'ArrowLeft' && at > 0) onMove(at - 1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [at, images.length, onMove, onClose])
  const toggleZoom = (e: React.MouseEvent<HTMLImageElement>) => {
    e.stopPropagation()
    const img = e.currentTarget
    const frame = measure(stageRef.current, img)
    if (!frame || !stageRef.current) return
    const tapped = fromCentre(stageRef.current, e)
    // Its own size, or twice fitted for one that already fits at its own size.
    const actual = Math.max(2, img.naturalWidth / frame.width)
    setView((was) => (was.scale > 1 ? FITTED : zoomAbout(FITTED, actual, tapped, frame)))
  }
  const zoomed = view.scale > 1
  return (
    <div className="control-images__viewer" role="dialog" aria-label={image.caption ?? 'Picture'} onClick={onClose}>
      <div ref={stageRef} className={`control-images__stage${zoomed ? ' control-images__stage--zoomed' : ''}`} {...{ [GESTURE_OWNER_ATTR]: '' }} {...gestures}>
        {typeof url === 'string'
          ? <img
              ref={imgRef}
              src={url}
              alt={image.caption ?? ''}
              draggable={false}
              style={zoomed ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : undefined}
              onClick={toggleZoom}
            />
          : <span className="control-images__placeholder">{url ? url.error : 'Loading…'}</span>}
      </div>
      <div className="control-images__bar" onClick={(e) => e.stopPropagation()}>
        <button disabled={at === 0} onClick={() => onMove(at - 1)} aria-label="Previous picture">‹</button>
        <span>{image.caption ?? ''}{images.length > 1 ? ` (${at + 1} of ${images.length})` : ''}</span>
        <button disabled={at === images.length - 1} onClick={() => onMove(at + 1)} aria-label="Next picture">›</button>
        <button onClick={onClose} aria-label="Close the picture">✕</button>
      </div>
    </div>
  )
}

export function ControlImages({ images, summary }: { images: ControlImage[]; summary?: string }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="control-images">
      {summary && <div className="control-images__summary">{summary}</div>}
      <div className="control-images__row">
        {images.map((image, i) => <Thumb key={`${i}-${image.id}`} image={image} onOpen={() => setOpen(i)} />)}
      </div>
      {open !== null && images[open] && <Viewer images={images} at={open} onMove={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}
