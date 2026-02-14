import { ipcMain } from 'electron'

const loadTTS = () => import('@echogarden/macos-native-tts')

interface TTSChunk {
  samples: ArrayBuffer
  sampleRate: number
  pauseAfterMs: number
}

let selectedVoice: string = 'en-US'
let abortFlag = false

function ensureTrailingPunctuation(line: string): string {
  const trimmed = line.trimEnd()
  if (trimmed.length === 0) return trimmed
  return /[.!?;:,]$/.test(trimmed) ? trimmed : trimmed + '.'
}

function stripMarkdown(text: string): string {
  return text
    // Fenced code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    // Italic
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Links
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Headers — strip marker and ensure trailing punctuation for TTS pause
    .replace(/^#{1,6}\s+(.*)/gm, (_m, content: string) => ensureTrailingPunctuation(content))
    // Blockquotes — strip marker and ensure trailing punctuation
    .replace(/^>\s+(.*)/gm, (_m, content: string) => ensureTrailingPunctuation(content))
    // List markers — strip marker and ensure trailing punctuation
    .replace(/^[\s]*[-*+]\s+(.*)/gm, (_m, content: string) => ensureTrailingPunctuation(content))
    .replace(/^[\s]*\d+\.\s+(.*)/gm, (_m, content: string) => ensureTrailingPunctuation(content))
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Clean up extra whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitIntoChunks(text: string): { text: string; pauseAfterMs: number }[] {
  return text
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => ({ text: segment, pauseAfterMs: 600 }))
}

async function pickVoice(): Promise<void> {
  try {
    const { getVoiceList } = await loadTTS()
    const voices = await getVoiceList()

    // Prefer premium/enhanced voices (Apple's high-quality voices)
    const premium = voices.find(
      (v: { identifier: string; language: string }) =>
        v.language.startsWith('en') && v.identifier.includes('premium')
    )
    if (premium) {
      selectedVoice = premium.identifier
      console.log('[TTS] Selected premium voice:', selectedVoice)
      return
    }

    // Try enhanced voices
    const enhanced = voices.find(
      (v: { identifier: string; language: string }) =>
        v.language.startsWith('en') && v.identifier.includes('enhanced')
    )
    if (enhanced) {
      selectedVoice = enhanced.identifier
      console.log('[TTS] Selected enhanced voice:', selectedVoice)
      return
    }

    // Try Samantha (default macOS English voice, good quality)
    const samantha = voices.find(
      (v: { identifier: string }) => v.identifier.includes('Samantha')
    )
    if (samantha) {
      selectedVoice = samantha.identifier
      console.log('[TTS] Selected Samantha voice:', selectedVoice)
      return
    }

    // Any non-eloquence en-US voice
    const nonEloquence = voices.find(
      (v: { identifier: string; language: string }) =>
        v.language.startsWith('en') && !v.identifier.includes('eloquence')
    )
    if (nonEloquence) {
      selectedVoice = nonEloquence.identifier
      console.log('[TTS] Selected non-eloquence voice:', selectedVoice)
      return
    }

    // Last resort
    const enUS = voices.find(
      (v: { identifier: string; language: string }) => v.language.startsWith('en-US')
    )
    if (enUS) {
      selectedVoice = enUS.identifier
      console.log('[TTS] Selected en-US fallback voice:', selectedVoice)
      return
    }
    selectedVoice = 'en-US'
    console.log('[TTS] Using default en-US')
  } catch (err) {
    console.log('[TTS] Voice selection failed:', err)
    selectedVoice = 'en-US'
  }
}

export function setupTTSHandlers(): void {
  pickVoice()

  ipcMain.handle('tts:speak', async (_event, text: string): Promise<{ chunks: TTSChunk[] }> => {
    abortFlag = false
    const stripped = stripMarkdown(text)
    const segments = splitIntoChunks(stripped)
    const chunks: TTSChunk[] = []

    for (const segment of segments) {
      if (abortFlag) break
      try {
        const { synthesize } = await loadTTS()
        const result = await synthesize(segment.text, { voice: selectedVoice })
        const raw = result.audioSamples

        // The native module returns Float32 PCM data mislabeled as Int16Array.
        // Reinterpret the underlying bytes as Float32.
        const f32 = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
        const buf = f32.buffer.slice(f32.byteOffset, f32.byteOffset + f32.byteLength)

        chunks.push({
          samples: buf,
          sampleRate: result.sampleRate,
          pauseAfterMs: segment.pauseAfterMs
        })
      } catch {
        // Skip failed segments
      }
    }

    return { chunks }
  })

  ipcMain.on('tts:stop', () => {
    abortFlag = true
  })
}
