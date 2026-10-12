import { useEffect, useState } from 'react'
import { ChoiceGroup } from '@/components/ChoiceGroup'
import { listensOnEarpiece, onEarpieceChange, setListenOnEarpiece } from './audio-session'

const OUTPUTS = [
  { value: 'speaker', label: 'Speaker' },
  { value: 'earpiece', label: 'Earpiece' },
] as const

/** Where the phone plays Control's voice: the speaker, or the earpiece, held to the ear. At the foot of the transcript. */
export function EarpieceSwitch() {
  const [earpiece, setEarpiece] = useState(listensOnEarpiece)
  useEffect(() => onEarpieceChange(setEarpiece), [])
  return (
    <ChoiceGroup
      label="Play Control on"
      caption="Play on"
      options={OUTPUTS}
      value={earpiece ? 'earpiece' : 'speaker'}
      onChoose={(output) => setListenOnEarpiece(output === 'earpiece')}
    />
  )
}
