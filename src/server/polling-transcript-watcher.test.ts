import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findNewestTranscript } from './polling-transcript-watcher'
import { CURSOR_TRANSCRIPTS } from './cursor-session-file-watcher'
import { CODEX_TRANSCRIPTS } from './codex-session-file-watcher'

/**
 * Transcript resolution against a real temporary tree. These walk the filesystem
 * on purpose — the layouts belong to Cursor and Codex, and a fake fs would only
 * assert that our idea of their layout matches itself.
 */
const ID = '0199c2f4-1a2b-4c3d-8e9f-a1b2c3d4e5f6'
const OTHER_ID = '0199aaaa-bbbb-cccc-dddd-eeeeffff0000'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceterm-transcripts-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(relPath: string, mtimeMs?: number): string {
  const full = path.join(root, relPath)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, '{}\n')
  if (mtimeMs !== undefined) fs.utimesSync(full, mtimeMs / 1000, mtimeMs / 1000)
  return full
}

describe('findNewestTranscript id validation', () => {
  it('rejects an empty id without searching', () => {
    write(`proj/${ID}/${ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, '', root)).toBeUndefined()
  })

  it('rejects a short id', () => {
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, 'abc123', root)).toBeUndefined()
  })

  it('rejects an id containing path separators', () => {
    // Otherwise a stray value could steer the walk somewhere unintended.
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, '../../etc/passwd0000', root)).toBeUndefined()
  })

  it('returns undefined when the root does not exist', () => {
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, path.join(root, 'nope'))).toBeUndefined()
  })

  it('returns undefined when nothing matches', () => {
    write('proj/unrelated.jsonl')
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBeUndefined()
  })
})

describe('cursor transcript layout', () => {
  it('finds <id>.jsonl inside a directory of the same name', () => {
    const target = write(`myproj/${ID}/${ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBe(target)
  })

  it('searches nested project directories', () => {
    const target = write(`a/b/c/${ID}/${ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBe(target)
  })

  it('ignores a matching filename whose parent directory does not match', () => {
    // The parent-directory check is what stops an unrelated same-named file
    // elsewhere in the tree from being picked up.
    write(`myproj/somewhere-else/${ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBeUndefined()
  })

  it('ignores another conversation', () => {
    write(`myproj/${OTHER_ID}/${OTHER_ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBeUndefined()
  })

  it('prefers the most recently modified copy when the id appears twice', () => {
    // Cursor re-registers a conversation under a new project directory when the
    // workspace moves; the live transcript is the newer one.
    write(`old-proj/${ID}/${ID}.jsonl`, 1_600_000_000_000)
    const newer = write(`new-proj/${ID}/${ID}.jsonl`, 1_700_000_000_000)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBe(newer)
  })

  it('does not match a codex-style name', () => {
    write(`myproj/${ID}/rollout-${ID}.jsonl`)
    expect(findNewestTranscript(CURSOR_TRANSCRIPTS, ID, root)).toBeUndefined()
  })
})

describe('codex transcript layout', () => {
  it('finds a rollout by its id suffix', () => {
    const target = write(`2026/07/31/rollout-2026-07-31T10-00-00-${ID}.jsonl`)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBe(target)
  })

  it('is independent of the dated directory depth', () => {
    const target = write(`whatever/rollout-${ID}.jsonl`)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBe(target)
  })

  it('ignores another session', () => {
    write(`2026/rollout-${OTHER_ID}.jsonl`)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBeUndefined()
  })

  it('requires the hyphen before the id', () => {
    // `<prefix><id>.jsonl` without the separator is a different file.
    write(`2026/rollout${ID}.jsonl`)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBeUndefined()
  })

  it('prefers the most recently modified rollout', () => {
    write(`2026/07/30/rollout-a-${ID}.jsonl`, 1_600_000_000_000)
    const newer = write(`2026/07/31/rollout-b-${ID}.jsonl`, 1_700_000_000_000)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBe(newer)
  })

  it('does not match a cursor-style bare name', () => {
    write(`2026/${ID}.jsonl`)
    expect(findNewestTranscript(CODEX_TRANSCRIPTS, ID, root)).toBeUndefined()
  })
})
