/**
 * Beat detector with autocorrelation-based BPM estimation and continuous
 * confidence tracking. No binary locked/unlocked modes.
 *
 * 1. Detect onsets via spectral flux.
 * 2. Maintain a rolling window of onset times (~8 seconds).
 * 3. Every few onsets, run autocorrelation on the onset signal to find
 *    the dominant period in the 80–180 BPM range.
 * 4. Phase accumulator always runs at the estimated BPM.
 * 5. On-grid onsets nudge phase/period and increase confidence.
 *    Off-grid onsets decrease confidence.
 *    Missed predicted beats decrease confidence.
 * 6. Confidence (0..1) is output directly for the renderer to map to color.
 */

const FLUX_HISTORY_SIZE = 20 // ~1s of flux for onset threshold
const MIN_BPM = 80
const MAX_BPM = 180
const MIN_PERIOD_MS = 60000 / MAX_BPM // ~333ms
const MAX_PERIOD_MS = 60000 / MIN_BPM // ~750ms

// Autocorrelation parameters
const ONSET_WINDOW_MS = 8000 // look at last 8 seconds of onsets
const AUTOCORR_BIN_MS = 10 // quantize onset signal to 10ms bins
const MIN_ONSETS_FOR_AUTOCORR = 4

// Phase-lock parameters
const ACCEPT_WINDOW = 0.20 // ±20% of beat period
const PHASE_CORRECTION_BASE = 0.15 // base phase correction, scaled by confidence
const PERIOD_CORRECTION_BASE = 0.05 // base period correction, scaled by confidence

// Confidence dynamics
const CONFIDENCE_BOOST = 0.12 // per on-grid onset
const CONFIDENCE_OFFGRID_PENALTY = 0.06 // per off-grid onset
const CONFIDENCE_MISS_PENALTY = 0.04 // per predicted beat with no onset
const CONFIDENCE_DECAY = 0.997 // per chunk (~20Hz), gentle drift toward 0

export interface BeatResult {
  beat: boolean
  onset: boolean
  energy: number
  bpm: number
  /** 0.0 = on beat, 1.0 = just before next beat */
  phase: number
  /** 0.0 = no idea, 1.0 = very confident in BPM lock */
  confidence: number
  hasSignal: boolean
}

export class BeatDetector {
  // Onset detection
  private prevEnergy = 0
  private fluxHistory = new Float64Array(FLUX_HISTORY_SIZE)
  private fluxIndex = 0
  private fluxFilled = 0

  // Onset history (timestamps)
  private onsetTimes: number[] = []

  // BPM / phase
  private beatPeriodMs = 0
  private phase = 0
  private lastChunkTime = 0
  private confidence = 0

  // Signal detection
  private _hasSignal = false

  // Throttle autocorrelation: run every N onsets
  private onsetsUntilAutocorr = MIN_ONSETS_FOR_AUTOCORR

  process(pcmBuffer: Buffer): BeatResult {
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.byteLength / 2))
    const numSamples = samples.length
    const now = Date.now()

    // Compute RMS energy
    let sumSquares = 0
    for (let i = 0; i < numSamples; i++) {
      const s = samples[i] / 32768
      sumSquares += s * s
    }
    const energy = Math.sqrt(sumSquares / numSamples)
    if (energy > 0.001) this._hasSignal = true

    // Onset detection via spectral flux
    const flux = Math.max(0, energy - this.prevEnergy)
    this.prevEnergy = energy

    this.fluxHistory[this.fluxIndex] = flux
    this.fluxIndex = (this.fluxIndex + 1) % FLUX_HISTORY_SIZE
    if (this.fluxFilled < FLUX_HISTORY_SIZE) this.fluxFilled++

    let fluxSum = 0
    for (let i = 0; i < this.fluxFilled; i++) fluxSum += this.fluxHistory[i]
    const fluxMean = fluxSum / this.fluxFilled
    let fluxVarSum = 0
    for (let i = 0; i < this.fluxFilled; i++) {
      const d = this.fluxHistory[i] - fluxMean
      fluxVarSum += d * d
    }
    const fluxThreshold = fluxMean + 1.5 * Math.sqrt(fluxVarSum / this.fluxFilled)

    const timeSinceLastOnset = this.onsetTimes.length > 0
      ? now - this.onsetTimes[this.onsetTimes.length - 1]
      : Infinity
    // Minimum gap: 70% of min period to avoid obvious double-triggers
    const isOnset = flux > fluxThreshold && flux > 0.003 && timeSinceLastOnset > MIN_PERIOD_MS * 0.7

    // Record onset
    if (isOnset) {
      this.onsetTimes.push(now)
      // Trim old onsets
      const cutoff = now - ONSET_WINDOW_MS
      while (this.onsetTimes.length > 0 && this.onsetTimes[0] < cutoff) {
        this.onsetTimes.shift()
      }

      // Periodically re-estimate BPM via autocorrelation
      this.onsetsUntilAutocorr--
      if (this.onsetsUntilAutocorr <= 0 && this.onsetTimes.length >= MIN_ONSETS_FOR_AUTOCORR) {
        this.onsetsUntilAutocorr = 3 // re-check every 3 onsets
        const newPeriod = this.autocorrelatePeriod(now)
        if (newPeriod > 0) {
          if (this.beatPeriodMs === 0) {
            // First estimate
            this.beatPeriodMs = newPeriod
            this.phase = 0
          } else {
            // Blend toward new estimate proportional to how different it is
            const ratio = newPeriod / this.beatPeriodMs
            if (ratio > 0.85 && ratio < 1.15) {
              // Close enough — smooth blend
              this.beatPeriodMs = this.beatPeriodMs * 0.8 + newPeriod * 0.2
            } else {
              // Big change — more aggressive adoption (song change, etc.)
              this.beatPeriodMs = this.beatPeriodMs * 0.4 + newPeriod * 0.6
              this.confidence *= 0.5
            }
          }
          this.beatPeriodMs = Math.max(MIN_PERIOD_MS, Math.min(MAX_PERIOD_MS, this.beatPeriodMs))
        }
      }
    }

    // Phase tracking
    let beat = false
    if (this.beatPeriodMs > 0 && this.lastChunkTime > 0) {
      const elapsed = now - this.lastChunkTime
      const prevPhase = this.phase
      this.phase += elapsed / this.beatPeriodMs

      // Check for phase wrap → predicted beat
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase)
        beat = true // predicted beat fires visually
        // Penalize confidence if no onset was near this predicted beat
        if (timeSinceLastOnset > this.beatPeriodMs * ACCEPT_WINDOW) {
          this.confidence = Math.max(0, this.confidence - CONFIDENCE_MISS_PENALTY)
        }
      }

      // Handle onset relative to phase
      if (isOnset) {
        const phaseError = this.phase < 0.5 ? this.phase : this.phase - 1.0
        if (Math.abs(phaseError) < ACCEPT_WINDOW) {
          // On-grid onset
          beat = true
          this.confidence = Math.min(1, this.confidence + CONFIDENCE_BOOST)

          // Nudge phase toward 0 (proportional to confidence for stability)
          const phaseCorr = PHASE_CORRECTION_BASE + this.confidence * 0.25
          if (this.phase < 0.5) {
            this.phase *= (1 - phaseCorr)
          } else {
            this.phase = 1 - (1 - this.phase) * (1 - phaseCorr)
          }

          // Nudge period
          if (timeSinceLastOnset > MIN_PERIOD_MS * 0.8 && timeSinceLastOnset < MAX_PERIOD_MS * 1.2) {
            const periodCorr = PERIOD_CORRECTION_BASE + this.confidence * 0.05
            this.beatPeriodMs = this.beatPeriodMs * (1 - periodCorr) + timeSinceLastOnset * periodCorr
            this.beatPeriodMs = Math.max(MIN_PERIOD_MS, Math.min(MAX_PERIOD_MS, this.beatPeriodMs))
          }
        } else {
          // Off-grid onset — reduce confidence
          this.confidence = Math.max(0, this.confidence - CONFIDENCE_OFFGRID_PENALTY)
        }
      }
    } else if (isOnset && this.beatPeriodMs > 0) {
      // We have a period but this is the first chunk — just reset phase
      this.phase = 0
      beat = true
    }

    // Gentle confidence decay
    this.confidence *= CONFIDENCE_DECAY

    this.lastChunkTime = now

    const bpm = this.beatPeriodMs > 0 ? Math.round(60000 / this.beatPeriodMs) : 0

    return { beat, onset: isOnset, energy, bpm, phase: this.phase, confidence: this.confidence, hasSignal: this._hasSignal }
  }

  /**
   * Autocorrelation-based BPM estimation.
   *
   * Quantizes recent onset times into a binary signal (10ms bins),
   * computes autocorrelation for all lags in the valid BPM range,
   * and returns the lag with the highest correlation.
   */
  private autocorrelatePeriod(now: number): number {
    if (this.onsetTimes.length < MIN_ONSETS_FOR_AUTOCORR) return 0

    const windowStart = now - ONSET_WINDOW_MS
    const numBins = Math.ceil(ONSET_WINDOW_MS / AUTOCORR_BIN_MS)

    // Build binary onset signal
    const signal = new Uint8Array(numBins)
    for (const t of this.onsetTimes) {
      if (t < windowStart) continue
      const bin = Math.floor((t - windowStart) / AUTOCORR_BIN_MS)
      if (bin >= 0 && bin < numBins) {
        signal[bin] = 1
        // Spread onset over ±1 bin for tolerance
        if (bin > 0) signal[bin - 1] = 1
        if (bin < numBins - 1) signal[bin + 1] = 1
      }
    }

    // Autocorrelation for lags in BPM range
    const minLag = Math.floor(MIN_PERIOD_MS / AUTOCORR_BIN_MS)
    const maxLag = Math.ceil(MAX_PERIOD_MS / AUTOCORR_BIN_MS)

    let bestLag = 0
    let bestCorr = 0

    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0
      const limit = numBins - lag
      for (let i = 0; i < limit; i++) {
        corr += signal[i] * signal[i + lag]
      }
      // Normalize by overlap length
      corr /= limit
      if (corr > bestCorr) {
        bestCorr = corr
        bestLag = lag
      }
    }

    if (bestLag === 0 || bestCorr < 0.01) return 0

    // Refine: parabolic interpolation around the peak
    if (bestLag > minLag && bestLag < maxLag) {
      const limit = numBins - bestLag
      let corrMinus = 0
      let corrPlus = 0
      for (let i = 0; i < limit; i++) {
        if (i < numBins - (bestLag - 1)) corrMinus += signal[i] * signal[i + bestLag - 1]
        if (i < numBins - (bestLag + 1)) corrPlus += signal[i] * signal[i + bestLag + 1]
      }
      corrMinus /= numBins - (bestLag - 1)
      corrPlus /= numBins - (bestLag + 1)

      const denom = 2 * (2 * bestCorr - corrMinus - corrPlus)
      if (denom > 0) {
        const refinement = (corrMinus - corrPlus) / denom
        return (bestLag + refinement) * AUTOCORR_BIN_MS
      }
    }

    return bestLag * AUTOCORR_BIN_MS
  }
}
