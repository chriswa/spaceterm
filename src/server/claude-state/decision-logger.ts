import * as fs from 'fs'
import * as path from 'path'
import { DECISION_LOG_DIR } from '../../shared/protocol'
import type { PtySessionId } from '../../shared/ids'

export interface DecisionLogEntry {
  timestamp: string
  source: 'hook' | 'jsonl' | 'client' | 'ledger' | 'status-line'
  event: string
  prevState: string
  newState: string
  /**
   * Epoch ms of the event that caused this decision (absent for client events,
   * which are applied directly rather than queued). Logged alongside the local
   * `timestamp` (when we decided) because the gap between the two IS the bug in
   * every ordering problem — a stale-suppressed transition is only legible if
   * you can see how far behind the event was.
   */
  sourceTime?: number
  detail?: string
  unread?: boolean
  suppressed?: boolean
}

export class DecisionLogger {
  constructor() {
    fs.mkdirSync(DECISION_LOG_DIR, { recursive: true })
  }

  log(surfaceId: PtySessionId, entry: DecisionLogEntry): void {
    const line = JSON.stringify(entry) + '\n'
    const logPath = path.join(DECISION_LOG_DIR, `${surfaceId}.jsonl`)
    fs.appendFile(logPath, line, () => {
      // fire-and-forget
    })
  }
}
