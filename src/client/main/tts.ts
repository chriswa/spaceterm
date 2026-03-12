import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { log } from './logger'

const loadTTS = () => import('@echogarden/macos-native-tts')

interface TTSChunk {
  samples: ArrayBuffer
  sampleRate: number
  pauseAfterMs: number
}

let selectedVoice: string = 'en-US'
let abortFlag = false
let nativeTtsAvailable = false
let cartesiaApiKey: string | null = null

// ---------------------------------------------------------------------------
// .env reading (shared pattern with api-usage.ts)
// ---------------------------------------------------------------------------

function readCartesiaKey(): string | null {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env')
    const text = fs.readFileSync(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*CARTESIA_API_KEY\s*=\s*(.+?)\s*$/)
      if (match) return match[1]
    }
  } catch {
    // .env not found or unreadable
  }
  return null
}

// ---------------------------------------------------------------------------
// Cartesia HTTP TTS (POST /tts/bytes — no SDK, no WebSocket)
// ---------------------------------------------------------------------------

const CARTESIA_SAMPLE_RATE = 44100
const CARTESIA_VOICE_ID = 'f786b574-daa5-4673-aa0c-cbe3e8534c02'
const CARTESIA_MODEL = 'sonic-3'

async function synthesizeWithCartesia(text: string): Promise<TTSChunk[]> {
  const { net } = await import('electron')
  const resp = await net.fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'Cartesia-Version': '2025-04-16',
      'X-API-Key': cartesiaApiKey!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: CARTESIA_VOICE_ID },
      language: 'en',
      output_format: {
        container: 'raw',
        encoding: 'pcm_f32le',
        sample_rate: CARTESIA_SAMPLE_RATE,
      },
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Cartesia API ${resp.status}: ${body}`)
  }

  const arrayBuf = await resp.arrayBuffer()
  if (arrayBuf.byteLength === 0) return []

  return [{ samples: arrayBuf, sampleRate: CARTESIA_SAMPLE_RATE, pauseAfterMs: 0 }]
}

// ---------------------------------------------------------------------------
// Text processing (shared by both backends)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Native macOS TTS (fallback)
// ---------------------------------------------------------------------------

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
      log(`[TTS] Selected premium voice: ${selectedVoice}`)
      nativeTtsAvailable = true
      return
    }

    // Try enhanced voices
    const enhanced = voices.find(
      (v: { identifier: string; language: string }) =>
        v.language.startsWith('en') && v.identifier.includes('enhanced')
    )
    if (enhanced) {
      selectedVoice = enhanced.identifier
      log(`[TTS] Selected enhanced voice: ${selectedVoice}`)
      nativeTtsAvailable = true
      return
    }

    // Try Samantha (default macOS English voice, good quality)
    const samantha = voices.find(
      (v: { identifier: string }) => v.identifier.includes('Samantha')
    )
    if (samantha) {
      selectedVoice = samantha.identifier
      log(`[TTS] Selected Samantha voice: ${selectedVoice}`)
      nativeTtsAvailable = true
      return
    }

    // Any non-eloquence en-US voice
    const nonEloquence = voices.find(
      (v: { identifier: string; language: string }) =>
        v.language.startsWith('en') && !v.identifier.includes('eloquence')
    )
    if (nonEloquence) {
      selectedVoice = nonEloquence.identifier
      log(`[TTS] Selected non-eloquence voice: ${selectedVoice}`)
      nativeTtsAvailable = true
      return
    }

    // Last resort
    const enUS = voices.find(
      (v: { identifier: string; language: string }) => v.language.startsWith('en-US')
    )
    if (enUS) {
      selectedVoice = enUS.identifier
      log(`[TTS] Selected en-US fallback voice: ${selectedVoice}`)
      nativeTtsAvailable = true
      return
    }
    selectedVoice = 'en-US'
    log('[TTS] No voices found, using default en-US')
    nativeTtsAvailable = true
  } catch (err) {
    log(`[TTS] Speech synthesis unavailable — could not load TTS module: ${err}`)
    selectedVoice = 'en-US'
    nativeTtsAvailable = false
  }
}

async function synthesizeWithNative(stripped: string): Promise<TTSChunk[]> {
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
      const copied = new ArrayBuffer(f32.byteLength)
      new Float32Array(copied).set(f32)

      chunks.push({
        samples: copied,
        sampleRate: result.sampleRate,
        pauseAfterMs: segment.pauseAfterMs
      })
    } catch {
      // Skip failed segments
    }
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function setupTTSHandlers(): void {
  cartesiaApiKey = readCartesiaKey()
  if (cartesiaApiKey) {
    log('[TTS] Cartesia API key found — using Cartesia for TTS')
  } else {
    log('[TTS] No Cartesia API key — falling back to native TTS')
  }

  // Only bother with native voice selection if no Cartesia key
  if (!cartesiaApiKey) {
    pickVoice()
  }

  ipcMain.handle('tts:speak', async (_event, text: string): Promise<{ chunks: TTSChunk[]; available: boolean }> => {
    abortFlag = false
    const stripped = stripMarkdown(text)

    if (cartesiaApiKey) {
      try {
        const chunks = await synthesizeWithCartesia(stripped)
        return { chunks, available: true }
      } catch (err) {
        log(`[TTS] Cartesia synthesis failed, falling back to native: ${err}`)
        // Fall through to native TTS
      }
    }

    if (!nativeTtsAvailable) {
      // Try to init native if we haven't yet (happens when Cartesia was primary but failed)
      if (!cartesiaApiKey) {
        return { chunks: [], available: false }
      }
      await pickVoice()
      if (!nativeTtsAvailable) {
        return { chunks: [], available: false }
      }
    }

    const chunks = await synthesizeWithNative(stripped)
    return { chunks, available: true }
  })

  ipcMain.on('tts:stop', () => {
    abortFlag = true
  })
}
