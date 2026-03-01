import { toggleSpeak, stopSpeaking, isSpeaking } from '../lib/tts-player'

export function useTTS() {
  return { speak: toggleSpeak, stop: stopSpeaking, isSpeaking }
}
