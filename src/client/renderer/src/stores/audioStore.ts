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
  plpEnabled: boolean
  // Stored values from both sources for instant switching
  stdBpm: number
  stdPhase: number
  stdConfidence: number
  plpBpm: number
  plpPhase: number
  plpConfidence: number
  init: () => () => void
  togglePlp: () => void
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
  plpEnabled: true,
  stdBpm: 0,
  stdPhase: 0,
  stdConfidence: 0,
  plpBpm: 0,
  plpPhase: 0,
  plpConfidence: 0,
  init: () => {
    const cleanup = window.api.audio.onBeat((data) => {
      const state = get()
      const plp = data.plp
      const stdBpm = data.bpm
      const stdPhase = data.phase
      const stdConfidence = data.confidence ?? 0
      const plpBpm = plp?.bpm ?? 0
      const plpPhase = plp?.phase ?? 0
      const plpConfidence = plp?.confidence ?? 0

      set({
        energy: data.energy,
        beat: data.beat,
        onset: data.onset ?? false,
        bpm: state.plpEnabled ? plpBpm : stdBpm,
        phase: state.plpEnabled ? plpPhase : stdPhase,
        confidence: state.plpEnabled ? plpConfidence : stdConfidence,
        hasSignal: data.hasSignal ?? false,
        listening: true,
        stdBpm,
        stdPhase,
        stdConfidence,
        plpBpm,
        plpPhase,
        plpConfidence
      })
    })
    return cleanup
  },
  togglePlp: () => {
    const state = get()
    const newPlpEnabled = !state.plpEnabled
    set({
      plpEnabled: newPlpEnabled,
      bpm: newPlpEnabled ? state.plpBpm : state.stdBpm,
      phase: newPlpEnabled ? state.plpPhase : state.stdPhase,
      confidence: newPlpEnabled ? state.plpConfidence : state.stdConfidence
    })
  }
}))
