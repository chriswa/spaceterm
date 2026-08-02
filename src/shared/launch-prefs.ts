/**
 * Settings that must be decided *before* Electron starts, so they cannot be
 * ordinary renderer state.
 *
 * Chromium reads its command line once, at process start, which is why these
 * live in a file the main process reads synchronously at module load rather
 * than in `localStorage` — by the time a renderer exists it is far too late to
 * influence them. Changing one therefore takes a restart, and the UI has to
 * say so.
 */
export interface LaunchPrefs {
  /**
   * macOS only, and only meaningful on a dual-GPU Mac: pin Chromium to the
   * discrete GPU instead of letting macOS pick.
   *
   * Off by default, deliberately. The discrete GPU is faster and hungrier, so
   * which setting is better depends on the machine and on what is being drawn
   * — which is the thing worth measuring with the power monitor rather than
   * guessing at.
   */
  highPerformanceGpu: boolean
}

export const DEFAULT_LAUNCH_PREFS: LaunchPrefs = {
  highPerformanceGpu: false,
}
