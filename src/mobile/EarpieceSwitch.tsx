import { useEffect, useState } from 'react'
import { listensOnEarpiece, onEarpieceChange, setListenOnEarpiece } from './audio-session'

/** Where the phone plays Control's voice: the earpiece, held to the ear, or the speaker. At the foot of the transcript. */
export function EarpieceSwitch() {
  const [earpiece, setEarpiece] = useState(listensOnEarpiece)
  useEffect(() => onEarpieceChange(setEarpiece), [])
  return (
    <button
      className="control-transcript__button"
      aria-label={earpiece ? 'Playing on the earpiece; switch to the speaker' : 'Playing on the speaker; switch to the earpiece'}
      onClick={() => setListenOnEarpiece(!earpiece)}
    >
      {earpiece ? 'Earpiece' : 'Speaker'}
    </button>
  )
}
