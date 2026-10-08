/**
 * How loud the voice going out is, for the microphone button's level bars.
 * Fed by every dictation from the blocks it is already sending
 * (dictation.ts), and read by the button once a frame while it is orange —
 * not a store, since a React update per audio block would redraw the bar
 * hundreds of times a second.
 */

/** Speech sits well inside this range; quieter is still, louder is full. */
const FLOOR_DB = -55
const CEILING_DB = -15
/** How fast the level falls once the sound stops: a bar is not a meter. */
const DECAY_PER_MS = 1 / 300

let level = 0
let at = 0

/** One block of what a dictation heard. */
export function noteMicLevel(block: Float32Array, now = performance.now()): void {
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
  const rms = Math.sqrt(sum / Math.max(1, block.length))
  const db = rms > 0 ? 20 * Math.log10(rms) : -120
  const heard = Math.max(0, Math.min(1, (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)))
  // Up at once, down gradually.
  level = Math.max(heard, micLevel(now))
  at = now
}

/** 0..1, falling away once nothing new is heard. */
export function micLevel(now = performance.now()): number {
  return Math.max(0, level - (now - at) * DECAY_PER_MS)
}
