import * as path from 'path'
import { homedir } from 'os'
import {
  PollingTranscriptWatcher,
  findNewestTranscript,
  type EntriesCallback,
  type TranscriptLocator,
} from './polling-transcript-watcher'

/**
 * Cursor stores a conversation as `<id>.jsonl` inside a directory also named
 * `<id>`, under a per-project tree we cannot derive from the chat id — so the
 * file has to be searched for. The parent-directory check matters: without it a
 * stray `<id>.jsonl` elsewhere in the tree would match.
 */
export const CURSOR_TRANSCRIPTS: TranscriptLocator = {
  rootDir: path.join(homedir(), '.cursor', 'projects'),
  matches(filePath: string, id: string): boolean {
    return path.basename(filePath) === `${id}.jsonl`
      && path.basename(path.dirname(filePath)) === id
  },
}

export function findCursorTranscript(conversationId: string, rootDir?: string): string | undefined {
  return findNewestTranscript(CURSOR_TRANSCRIPTS, conversationId, rootDir)
}

/** Tails Cursor's per-conversation JSONL, whose project directory is not derivable from a chat id. */
export class CursorSessionFileWatcher extends PollingTranscriptWatcher {
  constructor(onEntries: EntriesCallback) {
    super(CURSOR_TRANSCRIPTS, onEntries)
  }
}
