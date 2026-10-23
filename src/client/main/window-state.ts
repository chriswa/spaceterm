import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { screen } from 'electron'
import { SOCKET_DIR } from '../../shared/protocol'
import { writeFileAtomicSync } from './atomic-write'

export interface DisplayBounds {
  x: number
  y: number
  width: number
  height: number
}

interface WindowState {
  displayBounds: DisplayBounds
}

const STATE_FILE = join(SOCKET_DIR, 'window-state.json')

export function loadWindowState(): WindowState | null {
  if (!existsSync(STATE_FILE)) return null
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as WindowState
    if (!parsed || !parsed.displayBounds) return null
    const b = parsed.displayBounds
    if (typeof b.x !== 'number' || typeof b.y !== 'number' ||
        typeof b.width !== 'number' || typeof b.height !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function saveWindowState(displayBounds: DisplayBounds): void {
  writeFileAtomicSync(STATE_FILE, JSON.stringify({ displayBounds }, null, 2))
}

export function findTargetDisplay(saved: DisplayBounds): Electron.Display {
  const displays = screen.getAllDisplays()
  const match = displays.find(d =>
    d.bounds.x === saved.x &&
    d.bounds.y === saved.y &&
    d.bounds.width === saved.width &&
    d.bounds.height === saved.height
  )
  return match ?? screen.getPrimaryDisplay()
}
