import { cleanTerminalCopy } from './cleanTerminalCopy'

let audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/** Play a tiny frequency-sweep cue. Rising = start, falling = stop. */
function playCue(rising: boolean): void {
  const ctx = getAudioContext()
  const now = ctx.currentTime
  const duration = 0.08
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rising ? 520 : 780, now)
  osc.frequency.linearRampToValueAtTime(rising ? 780 : 520, now + duration)
  gain.gain.setValueAtTime(0.15, now)
  gain.gain.linearRampToValueAtTime(0, now + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(now)
  osc.stop(now + duration)
}

const INTER_UTTERANCE_GAP_MS = 1000
/**
 * Hard cap on how long we'll wait for a single utterance to finish before
 * giving up, force-stopping cartesia-read, and moving on. Generous enough to
 * cover the 2000-char MCP max at normal speech rate; tight enough that a hung
 * subprocess can't permanently block the queue.
 */
const SPEAK_TIMEOUT_MS = 180_000

type QueueItem = {
  text: string
  resolve: (available: boolean) => void
}

let speaking = false
/** Incremented whenever the queue is cleared so in-flight work can detect pre-emption. */
let generation = 0
let queue: QueueItem[] = []
let queueRunning = false

export function stopSpeaking(): void {
  generation++
  const cancelled = queue
  queue = []
  const wasSpeaking = speaking
  speaking = false
  window.api.tts.stop()
  if (wasSpeaking) playCue(false)
  for (const item of cancelled) item.resolve(true) // cancelled items aren't an availability error
}

async function runQueue(): Promise<void> {
  if (queueRunning) return
  queueRunning = true
  try {
    while (queue.length > 0) {
      const item = queue.shift()!
      const myGeneration = generation
      speaking = true
      playCue(true)
      let available = true
      try {
        const cleaned = cleanTerminalCopy(item.text)
        const TIMED_OUT = Symbol('timed-out')
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
          timeoutHandle = setTimeout(() => resolve(TIMED_OUT), SPEAK_TIMEOUT_MS)
        })
        const result = await Promise.race([window.api.tts.speak(cleaned), timeoutPromise])
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
        if (result === TIMED_OUT) {
          window.api.tts.stop() // force-kill the stuck subprocess so the next item can run
        } else {
          available = result.available
        }
      } catch {
        available = false
      }
      if (myGeneration !== generation) {
        item.resolve(available)
        return
      }
      speaking = false
      playCue(false)
      item.resolve(available)
      if (queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, INTER_UTTERANCE_GAP_MS))
        if (myGeneration !== generation) return
      }
    }
  } finally {
    queueRunning = false
  }
}

/**
 * Queue text to be spoken aloud via cartesia-read. If something is already
 * playing, this utterance is appended and plays after the current one finishes
 * (with a short buffer between items). Runs the shared terminal copy-cleanup
 * transform before handing text to Cartesia. Resolves to false if TTS is
 * unavailable.
 */
export function speakText(text: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ text, resolve })
    void runQueue()
  })
}

/**
 * Toggle speech: if anything is playing or queued, stop everything; otherwise
 * queue the text. Resolves to false only when starting fresh and TTS is
 * unavailable.
 */
export function toggleSpeak(text: string): Promise<boolean> {
  if (speaking || queue.length > 0) {
    stopSpeaking()
    return Promise.resolve(true)
  }
  return speakText(text)
}

export function isSpeaking(): boolean {
  return speaking || queue.length > 0
}
