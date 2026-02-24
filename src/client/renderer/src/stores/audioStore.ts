import { create } from 'zustand'

interface AudioState {
  energy: number
  beat: boolean
  onset: boolean
  bpm: number
  /** 0.0 = on beat, 1.0 = just before next beat */
  phase: number
  /** 0.0 = no confidence, 1.0 = fully locked */
  confidence: number
  hasSignal: boolean
  listening: boolean
  beatsVisible: boolean
  init: () => () => void
  toggleBeats: () => void
}

export const useAudioStore = create<AudioState>((set, get) => ({
  energy: 0,
  beat: false,
  onset: false,
  bpm: 0,
  phase: 0,
  confidence: 0,
  hasSignal: false,
  listening: false,
  beatsVisible: localStorage.getItem('toolbar.audioVis') === 'true',
  init: () => {
    const cleanup = window.api.audio.onBeat((data) => {
      set({
        energy: data.energy,
        beat: data.beat,
        onset: data.onset ?? false,
        bpm: data.bpm,
        phase: data.phase,
        confidence: data.confidence ?? 0,
        hasSignal: data.hasSignal ?? false,
        listening: true
      })
    })
    return cleanup
  },
  toggleBeats: () => { const next = !get().beatsVisible; localStorage.setItem('toolbar.audioVis', String(next)); set({ beatsVisible: next }) }
}))
