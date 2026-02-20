import * as fs from 'fs'
import * as path from 'path'
import { DECISION_LOG_DIR } from '../shared/protocol'

export interface DecisionLogEntry {
  timestamp: string
  source: 'hook' | 'jsonl' | 'client' | 'stale'
  event: string
  prevState: string
  newState: string
  detail?: string
  unread?: boolean
  suppressed?: boolean
}

export class DecisionLogger {
  constructor() {
    fs.mkdirSync(DECISION_LOG_DIR, { recursive: true })
  }

  log(surfaceId: string, entry: DecisionLogEntry): void {
    const line = JSON.stringify(entry) + '\n'
    const logPath = path.join(DECISION_LOG_DIR, `${surfaceId}.jsonl`)
    fs.appendFile(logPath, line, () => {
      // fire-and-forget
    })
  }
}
