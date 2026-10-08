import { useEffect, useState } from 'react'
import { listensOnEarpiece, onEarpieceChange, setListenOnEarpiece } from './audio-session'

/** Where the phone plays Control's voice: the earpiece, held to the ear, or the speaker. In the transcript's header. */
export function EarpieceSwitch() {
  const [earpiece, setEarpiece] = useState(listensOnEarpiece)
  useEffect(() => onEarpieceChange(setEarpiece), [])
  return (
    <button
      className="control-transcript__header-button"
      aria-label={earpiece ? 'Playing on the earpiece; switch to the speaker' : 'Playing on the speaker; switch to the earpiece'}
      onClick={() => setListenOnEarpiece(!earpiece)}
    >
      {earpiece ? 'Earpiece' : 'Speaker'}
    </button>
  )
}
