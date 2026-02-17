/**
 * PLP (Predominant Local Pulse) beat detector.
 *
 * Unlike the standard BeatDetector which autocorrelates binary onset events,
 * PLP autocorrelates the continuous onset strength signal, producing smoother
 * and more robust BPM estimates for complex rhythms.
 *
 * Algorithm:
 * 1. Compute RMS energy from PCM buffer
 * 2. Compute onset strength as half-wave rectified energy difference
 * 3. Store onset strength values in a circular buffer (~8s at ~20Hz)
 * 4. Periodically autocorrelate the onset strength buffer for dominant period
 * 5. Phase accumulator advances at estimated period
 * 6. Phase correction: onset strength peaks near predicted beats nudge phase
 * 7. Confidence from autocorrelation peak height + phase prediction accuracy
 * 8. Beat fires on phase wrap (1.0 → 0.0)
 */

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

const MIN_BPM = 80
const MAX_BPM = 160
const MIN_PERIOD_MS = 60000 / MAX_BPM // ~333ms
const MAX_PERIOD_MS = 60000 / MIN_BPM // ~750ms

// Onset strength buffer: ~8 seconds at ~20Hz = 160 samples
const STRENGTH_BUFFER_SIZE = 160
// How often to run autocorrelation (in chunks, ~1 second at 20Hz)
const AUTOCORR_INTERVAL = 20
// Chunk rate assumption for converting lag to ms
const CHUNK_INTERVAL_MS = 50 // ~20Hz

// Phase correction
const PHASE_CORRECTION_STRENGTH = 0.12
// Confidence dynamics
const CONFIDENCE_DECAY = 0.997
const CONFIDENCE_PEAK_BOOST = 0.08
const CONFIDENCE_MISS_PENALTY = 0.03

export class PLPDetector {
  // Energy tracking
  private prevEnergy = 0

  // Circular buffer of onset strength values
  private strengthBuffer = new Float64Array(STRENGTH_BUFFER_SIZE)
  private strengthIndex = 0
  private strengthFilled = 0

  // BPM / phase
  private beatPeriodMs = 0
  private phase = 0
  private lastChunkTime = 0
  private confidence = 0

  // Signal detection
  private _hasSignal = false

  // Autocorrelation throttle
  private chunksSinceAutocorr = 0

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

    // Onset strength: half-wave rectified energy difference (continuous, not thresholded)
    const onsetStrength = Math.max(0, energy - this.prevEnergy)
    this.prevEnergy = energy

    // Store in circular buffer
    this.strengthBuffer[this.strengthIndex] = onsetStrength
    this.strengthIndex = (this.strengthIndex + 1) % STRENGTH_BUFFER_SIZE
    if (this.strengthFilled < STRENGTH_BUFFER_SIZE) this.strengthFilled++

    // Periodically run autocorrelation on the continuous onset strength signal
    this.chunksSinceAutocorr++
    if (this.chunksSinceAutocorr >= AUTOCORR_INTERVAL && this.strengthFilled >= STRENGTH_BUFFER_SIZE / 2) {
      this.chunksSinceAutocorr = 0
      const newPeriod = this.autocorrelatePeriod()
      if (newPeriod > 0) {
        if (this.beatPeriodMs === 0) {
          this.beatPeriodMs = newPeriod
          this.phase = 0
        } else {
          const ratio = newPeriod / this.beatPeriodMs
          if (ratio > 0.85 && ratio < 1.15) {
            this.beatPeriodMs = this.beatPeriodMs * 0.8 + newPeriod * 0.2
          } else {
            this.beatPeriodMs = this.beatPeriodMs * 0.4 + newPeriod * 0.6
            this.confidence *= 0.5
          }
        }
        this.beatPeriodMs = Math.max(MIN_PERIOD_MS, Math.min(MAX_PERIOD_MS, this.beatPeriodMs))
      }
    }

    // Phase tracking
    let beat = false
    if (this.beatPeriodMs > 0 && this.lastChunkTime > 0) {
      const elapsed = now - this.lastChunkTime
      this.phase += elapsed / this.beatPeriodMs

      // Phase wrap → predicted beat
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase)
        beat = true
        // Penalize if current onset strength is very low at predicted beat
        if (onsetStrength < 0.002) {
          this.confidence = Math.max(0, this.confidence - CONFIDENCE_MISS_PENALTY)
        }
      }

      // Phase correction from onset strength peaks
      // When onset strength is high and we're near a predicted beat, nudge phase
      if (onsetStrength > 0.005) {
        const phaseError = this.phase < 0.5 ? this.phase : this.phase - 1.0
        if (Math.abs(phaseError) < 0.25) {
          // On-grid peak: boost confidence and nudge phase
          beat = true
          this.confidence = Math.min(1, this.confidence + CONFIDENCE_PEAK_BOOST * Math.min(1, onsetStrength * 50))

          const correction = PHASE_CORRECTION_STRENGTH * Math.min(1, onsetStrength * 30)
          if (this.phase < 0.5) {
            this.phase *= (1 - correction)
          } else {
            this.phase = 1 - (1 - this.phase) * (1 - correction)
          }
        }
      }
    } else if (this.beatPeriodMs > 0 && onsetStrength > 0.005) {
      // First chunk with a period: reset phase
      this.phase = 0
      beat = true
    }

    // Gentle confidence decay
    this.confidence *= CONFIDENCE_DECAY

    this.lastChunkTime = now

    const bpm = this.beatPeriodMs > 0 ? Math.round(60000 / this.beatPeriodMs) : 0

    return { beat, onset: false, energy, bpm, phase: this.phase, confidence: this.confidence, hasSignal: this._hasSignal }
  }

  /**
   * Autocorrelation on the continuous onset strength signal.
   *
   * Uses Pearson correlation (per-lag normalization) so that each lag is
   * evaluated fairly. A naive total-energy normalization is biased toward
   * shorter lags because the sparse onset-strength signal's near-zero
   * background self-correlates strongly and longer lags have fewer terms.
   */
  private autocorrelatePeriod(): number {
    const len = this.strengthFilled
    if (len < STRENGTH_BUFFER_SIZE / 2) return 0

    // Linearize the circular buffer into a contiguous array
    const signal = new Float64Array(len)
    for (let i = 0; i < len; i++) {
      signal[i] = this.strengthBuffer[(this.strengthIndex - len + i + STRENGTH_BUFFER_SIZE) % STRENGTH_BUFFER_SIZE]
    }

    // Compute mean and subtract for zero-mean signal
    let mean = 0
    for (let i = 0; i < len; i++) mean += signal[i]
    mean /= len
    for (let i = 0; i < len; i++) signal[i] -= mean

    // Compute autocorrelation for lags in BPM range
    // Convert BPM range to lag range in chunks
    const minLag = Math.floor(MIN_PERIOD_MS / CHUNK_INTERVAL_MS)
    const maxLag = Math.min(Math.ceil(MAX_PERIOD_MS / CHUNK_INTERVAL_MS), Math.floor(len / 2))

    if (minLag >= maxLag) return 0

    // Pre-compute cumulative sum-of-squares for efficient per-lag energy
    // prefixSq[i] = sum(signal[0..i-1]^2)
    const prefixSq = new Float64Array(len + 1)
    for (let i = 0; i < len; i++) {
      prefixSq[i + 1] = prefixSq[i] + signal[i] * signal[i]
    }
    const totalEnergy = prefixSq[len]
    if (totalEnergy < 1e-10) return 0

    let bestLag = 0
    let bestCorr = -1

    for (let lag = minLag; lag <= maxLag; lag++) {
      const overlap = len - lag
      let num = 0
      for (let i = 0; i < overlap; i++) {
        num += signal[i] * signal[i + lag]
      }
      // Per-lag Pearson normalization: energy of left segment [0..overlap-1]
      // and right segment [lag..len-1]
      const energyLeft = prefixSq[overlap]           // sum(signal[0..overlap-1]^2)
      const energyRight = prefixSq[len] - prefixSq[lag] // sum(signal[lag..len-1]^2)
      const denom = Math.sqrt(energyLeft * energyRight)
      if (denom < 1e-10) continue
      const corr = num / denom
      if (corr > bestCorr) {
        bestCorr = corr
        bestLag = lag
      }
    }

    if (bestLag === 0 || bestCorr < 0.05) return 0

    // Update confidence from autocorrelation peak height
    this.confidence = Math.min(1, this.confidence + bestCorr * 0.15)

    // Parabolic interpolation for sub-sample accuracy
    if (bestLag > minLag && bestLag < maxLag) {
      // Recompute neighbors with same normalization
      const computeCorr = (lag: number): number => {
        const overlap = len - lag
        let num = 0
        for (let i = 0; i < overlap; i++) num += signal[i] * signal[i + lag]
        const eL = prefixSq[overlap]
        const eR = prefixSq[len] - prefixSq[lag]
        const d = Math.sqrt(eL * eR)
        return d > 1e-10 ? num / d : 0
      }
      const corrMinus = computeCorr(bestLag - 1)
      const corrPlus = computeCorr(bestLag + 1)

      const denomP = 2 * (2 * bestCorr - corrMinus - corrPlus)
      if (denomP > 0) {
        const refinement = (corrMinus - corrPlus) / denomP
        return (bestLag + refinement) * CHUNK_INTERVAL_MS
      }
    }

    return bestLag * CHUNK_INTERVAL_MS
  }
}
