import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { PLPDetector } from './plp-detector'
import * as audioTap from './audio-tap'
import * as logger from '../logger'

export function setupAudio(mainWindow: BrowserWindow): void {
  logger.log('[audio] setupAudio: creating detector...')
  const detector = new PLPDetector()
  let chunkCount = 0
  logger.log('[audio] setupAudio: detector created, wiring callbacks...')

  audioTap.onData((chunk) => {
    chunkCount++
    const result = detector.process(chunk.data)
    if (chunkCount % 400 === 0) {
      logger.log(`[audio] chunk #${chunkCount} energy=${result.energy.toFixed(4)} bpm=${result.bpm} phase=${result.phase.toFixed(2)} conf=${result.confidence.toFixed(2)} beat=${result.beat}`)
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('audio:beat', {
        energy: result.energy,
        beat: result.beat,
        onset: result.onset,
        bpm: result.bpm,
        phase: result.phase,
        confidence: result.confidence,
        hasSignal: result.hasSignal
      })
    }
  })

  ipcMain.handle('audio:start', async () => {
    await audioTap.start()
  })

  ipcMain.handle('audio:stop', async () => {
    await audioTap.stop()
  })

  // Auto-start audio capture
  logger.log('[audio] setupAudio: triggering auto-start...')
  audioTap.start().then(() => {
    logger.log('[audio] auto-start resolved successfully')
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    logger.log(`[audio] auto-start failed: ${msg}`)
  })
}
