import { mkdirSync, unlinkSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { SOCKET_DIR } from '../../shared/protocol'

const DIR = SOCKET_DIR
export const LOG_PATH = join(DIR, 'electron.log')

export function init(): void {
  mkdirSync(DIR, { recursive: true })
  try {
    unlinkSync(LOG_PATH)
  } catch {
    // file didn't exist — fine
  }
  writeFileSync(LOG_PATH, '')
}

export function log(message: string): void {
  appendFileSync(LOG_PATH, `${new Date().toISOString()}  ${message}\n`)
}
