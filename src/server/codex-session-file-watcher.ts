import * as path from 'path'
import { homedir } from 'os'
import {
  PollingTranscriptWatcher,
  findNewestTranscript,
  type EntriesCallback,
  type TranscriptLocator,
} from './polling-transcript-watcher'

/**
 * Codex names a rollout `<timestamp-ish-prefix>-<sessionUuid>.jsonl` under a
 * dated directory layout. Matching on the id suffix rather than the whole name
 * keeps this independent of that layout, which is not ours to depend on.
 */
export const CODEX_TRANSCRIPTS: TranscriptLocator = {
  rootDir: path.join(homedir(), '.codex', 'sessions'),
  matches(filePath: string, id: string): boolean {
    return path.basename(filePath).endsWith(`-${id}.jsonl`)
  },
}

/** Locate one Codex rollout by its globally unique session UUID. */
export function findCodexSessionFile(sessionId: string, rootDir?: string): string | undefined {
  return findNewestTranscript(CODEX_TRANSCRIPTS, sessionId, rootDir)
}

/**
 * Tails Codex's UUID-named rollout JSONL for a surface. Codex hooks provide a
 * session id but not a transcript path; resolving the filename once lets the
 * shared file watcher follow the file without depending on its dated layout.
 */
export class CodexSessionFileWatcher extends PollingTranscriptWatcher {
  constructor(onEntries: EntriesCallback) {
    super(CODEX_TRANSCRIPTS, onEntries)
  }
}
