import { useDictationSession } from './dictation-session'

/**
 * Dictation is still listening, with no composer open: a mark at the bottom
 * bar's right. Only a mark — any composer shows the
 * dictation, and stops or ships it.
 */
export function DictationIndicator() {
  const mic = useDictationSession((s) => s.mic)
  const label = mic.kind === 'transcribing' ? 'Transcribing' : mic.kind === 'starting' ? 'Starting the microphone' : 'Still dictating — open a composer to stop or ship it'
  return (
    <div className={`m-dictating m-dictating--${mic.kind}`} role="status" aria-label={label}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <path d="M12 18v3" />
      </svg>
    </div>
  )
}
