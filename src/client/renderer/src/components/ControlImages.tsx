import { useEffect, useState } from 'react'
import type { ControlImage } from '../../../../shared/protocol'
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

/**
 * One picture over the whole window, fitted to it; a tap on it shows it at
 * its own size, to scroll about, and a tap outside it, or Escape, closes it.
 * Inside the transcript's dialog, so a press on it is not a press outside the
 * dialog that closes the transcript.
 */
function Viewer({ images, at, onMove, onClose }: { images: ControlImage[]; at: number; onMove: (to: number) => void; onClose: () => void }) {
  const image = images[at]
  const url = useImageUrl(image.id, 'full')
  const [actual, setActual] = useState(false)
  useEffect(() => setActual(false), [at])
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
  return (
    <div className="control-images__viewer" role="dialog" aria-label={image.caption ?? 'Picture'} onClick={onClose}>
      <div className={`control-images__stage${actual ? ' control-images__stage--actual' : ''}`}>
        {typeof url === 'string'
          ? <img src={url} alt={image.caption ?? ''} onClick={(e) => { e.stopPropagation(); setActual((was) => !was) }} />
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
