/**
 * The turn tone: a tuning aid for hands-free's turn threshold. Every answer
 * the turn model (Smart Turn, on the Mac) gives at a pause in a dictation —
 * the very answers that decide whether the dictation ends there
 * (hands-free.ts `askAboutPause`) — is played at once as a short tone, low
 * for "still going", high for "finished", so the data the decision runs on
 * can be heard. The answer that ended the dictation is held a little longer.
 *
 * It asks nothing of its own: an earlier version questioned the model ten
 * times a second through every pause, which was a different series from the
 * one that decides. Those answers are in the record already, one
 * `hands-free-turn` line each.
 *
 * Switched by `TURN_TONE_ON` below, off by default.
 */

/** Whether the turn tone plays. Off since October 12, 2026: it had served its purpose and was only in the way. */
export const TURN_TONE_ON = false

/** p = 0 sounds A3, p = 1 three octaves up at A6; whole semitones, so a change is a step you can hear. */
const LOW_HZ = 220
const OCTAVES = 3

export function turnTonePitch(p: number): number {
  const semitones = Math.round(Math.min(1, Math.max(0, p)) * OCTAVES * 12)
  return LOW_HZ * 2 ** (semitones / 12)
}

/** Short for an answer the dictation went on past; longer for the one that ended it. */
export const TURN_TONE_SECONDS = 0.035
export const TURN_TONE_ENDING_SECONDS = 0.07

/** The tone for one answer: `ends`, whether that answer ended the dictation. */
export function turnTone(p: number, ends: boolean): { frequency: number; seconds: number } {
  return { frequency: turnTonePitch(p), seconds: ends ? TURN_TONE_ENDING_SECONDS : TURN_TONE_SECONDS }
}
