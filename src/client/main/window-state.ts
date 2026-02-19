import { writeFileSync, readFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { screen } from 'electron'
import { SOCKET_DIR } from '../../shared/protocol'

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
const STATE_TMP = STATE_FILE + '.tmp'

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
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const data = JSON.stringify({ displayBounds }, null, 2)
  writeFileSync(STATE_TMP, data, 'utf-8')
  const fd = openSync(STATE_TMP, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(STATE_TMP, STATE_FILE)
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
