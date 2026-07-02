import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { AttrSpan, SnapshotRow, SnapshotMessage } from '../shared/protocol'
import { DEFAULT_FG, DEFAULT_BG } from '../shared/theme'
import { resolveFg, resolveBg } from '../shared/terminal-colors'

const TICK_INTERVAL = 100 // 10 ticks/sec, one dirty session per tick

// Lines of scrollback retained by each headless terminal. This bounds both the
// scrollback a re-attaching client can scroll through and the size/cost of the
// serialized attach payload. Keep the client xterm's `scrollback` option in
// sync (see TerminalCard).
export const SCROLLBACK_LINES = 1000

export type SnapshotCallback = (snapshot: SnapshotMessage) => void

// activeProtocol → the DECSET that enables it. xterm tracks the mouse tracking
// mode here, and SerializeAddon already reproduces it (from terminal.modes), but
// we re-assert it too so the encoding below always lands in a consistent state.
const MOUSE_PROTOCOL_DECSET: Record<string, string> = {
  X10: '\x1b[?9h',
  VT200: '\x1b[?1000h',
  DRAG: '\x1b[?1002h',
  ANY: '\x1b[?1003h',
}
// activeEncoding → the DECSET that enables it. THIS is the gap: xterm tracks the
// mouse *encoding* in coreMouseService, NOT in terminal.modes, so SerializeAddon
// cannot reproduce it. A TUI like Claude Code enables SGR encoding (?1006h) once
// at startup and only re-emits it on a full redraw; without it a revived terminal
// reports wheel/click events in the legacy X10 encoding the app can't parse, so
// scrolling and clicks silently break until the app next redraws (e.g. on input).
const MOUSE_ENCODING_DECSET: Record<string, string> = {
  SGR: '\x1b[?1006h',
  SGR_PIXELS: '\x1b[?1016h',
}

/**
 * Re-assert the live mouse tracking protocol + encoding as DECSET sequences,
 * read from the emulator's coreMouseService (the encoding is not otherwise
 * serializable). Returns '' when mouse tracking is off.
 */
function serializeMouseState(terminal: Terminal): string {
  const core = (terminal as unknown as {
    _core?: { coreMouseService?: { activeProtocol: string; activeEncoding: string } }
  })._core?.coreMouseService
  if (!core) return ''
  return (MOUSE_PROTOCOL_DECSET[core.activeProtocol] ?? '') + (MOUSE_ENCODING_DECSET[core.activeEncoding] ?? '')
}

interface HeadlessSession {
  sessionId: string
  terminal: Terminal
  serialize: SerializeAddon
  cols: number
  rows: number
}

export class SnapshotManager {
  private sessions = new Map<string, HeadlessSession>()
  private dirtySet = new Set<string>()
  private lastSnapshotTime = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private onSnapshot: SnapshotCallback

  constructor(onSnapshot: SnapshotCallback) {
    this.onSnapshot = onSnapshot
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL)
  }

  addSession(sessionId: string, cols: number, rows: number): void {
    const terminal = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true })
    const serialize = new SerializeAddon()
    // SerializeAddon is typed against @xterm/xterm's Terminal, but the runtime
    // API is identical for @xterm/headless (verified by round-trip test).
    // Derive the expected param type from this terminal to bridge the two.
    terminal.loadAddon(serialize as unknown as Parameters<typeof terminal.loadAddon>[0])
    this.sessions.set(sessionId, { sessionId, terminal, serialize, cols, rows })
    this.lastSnapshotTime.set(sessionId, 0)
  }

  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.terminal.dispose()
      this.sessions.delete(sessionId)
      this.dirtySet.delete(sessionId)
      this.lastSnapshotTime.delete(sessionId)
    }
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.terminal.write(data)
    this.dirtySet.add(sessionId)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.terminal.resize(cols, rows)
    session.cols = cols
    session.rows = rows
    this.dirtySet.add(sessionId)
  }

  /**
   * Serialize the full live state of a session — scrollback, current screen,
   * cursor, SGR styling, terminal modes (mouse tracking, bracketed paste, …)
   * and the alternate-screen buffer — into a single replayable escape-sequence
   * string. Replaying it into a fresh xterm restores all of that by
   * construction, which a truncated raw-byte replay cannot (it loses the
   * one-time mode-setup sequences emitted at session start).
   *
   * The empty-string write is a drain barrier: xterm parses writes
   * asynchronously, and an empty write's callback fires only after every chunk
   * queued before it has been parsed. So the serialized state is a precise cut
   * of the data stream. Callers MUST begin buffering this session's live output
   * before calling, and flush that buffer after the callback fires — otherwise
   * data straddling the cut is lost or duplicated.
   */
  serializeForAttach(sessionId: string, cb: (state: string | null) => void): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      cb(null)
      return
    }
    session.terminal.write('', () => {
      try {
        const state = session.serialize.serialize({ scrollback: SCROLLBACK_LINES })
        cb(state + serializeMouseState(session.terminal))
      } catch {
        cb(null)
      }
    })
  }

  /** Force an immediate snapshot for a specific session */
  snapshotNow(sessionId: string): SnapshotMessage | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    this.dirtySet.delete(sessionId)
    this.lastSnapshotTime.set(sessionId, Date.now())
    return this.serializeSession(session)
  }

  private tick(): void {
    if (this.dirtySet.size === 0) return

    // Pick the dirty session with the oldest last-snapshot time
    let oldestId: string | null = null
    let oldestTime = Infinity
    for (const id of this.dirtySet) {
      const t = this.lastSnapshotTime.get(id) ?? 0
      if (t < oldestTime) {
        oldestTime = t
        oldestId = id
      }
    }
    if (!oldestId) return

    const session = this.sessions.get(oldestId)
    if (!session) {
      this.dirtySet.delete(oldestId)
      return
    }

    this.dirtySet.delete(oldestId)
    this.lastSnapshotTime.set(oldestId, Date.now())
    const snapshot = this.serializeSession(session)
    this.onSnapshot(snapshot)
  }

  private serializeSession(session: HeadlessSession): SnapshotMessage {
    const { terminal, sessionId, cols, rows } = session
    const buffer = terminal.buffer.active
    const lines: SnapshotRow[] = []

    // `getLine` indexes the whole buffer (0 = oldest scrollback line). Now that
    // the terminal retains scrollback, the visible screen starts at baseY, not
    // 0. cursorX/cursorY are already viewport-relative, so they need no offset.
    const base = buffer.baseY

    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(base + y)
      if (!line) {
        lines.push([{ text: ' '.repeat(cols), fg: DEFAULT_FG, bg: DEFAULT_BG }])
        continue
      }

      const row: AttrSpan[] = []
      let spanText = ''
      let spanFg = DEFAULT_FG
      let spanBg = DEFAULT_BG
      let spanBold = false
      let spanItalic = false
      let spanUnderline = false

      for (let x = 0; x < cols; x++) {
        const cell = line.getCell(x)
        if (!cell) {
          spanText += ' '
          continue
        }

        const char = cell.getChars() || ' '
        const inverse = !!(cell.isInverse && cell.isInverse())
        let fg = resolveFg(cell)
        let bg = resolveBg(cell)
        if (inverse) { const tmp = fg; fg = bg; bg = tmp }
        const bold = !!(cell.isBold && cell.isBold())
        const italic = !!(cell.isItalic && cell.isItalic())
        const underline = !!(cell.isUnderline && cell.isUnderline())

        // If attributes changed, emit previous span and start new one
        if (spanText.length > 0 && (fg !== spanFg || bg !== spanBg || bold !== spanBold || italic !== spanItalic || underline !== spanUnderline)) {
          const span: AttrSpan = { text: spanText, fg: spanFg, bg: spanBg }
          if (spanBold) span.bold = true
          if (spanItalic) span.italic = true
          if (spanUnderline) span.underline = true
          row.push(span)
          spanText = ''
        }

        if (spanText.length === 0) {
          spanFg = fg
          spanBg = bg
          spanBold = bold
          spanItalic = italic
          spanUnderline = underline
        }

        spanText += char
      }

      // Emit final span
      if (spanText.length > 0) {
        const span: AttrSpan = { text: spanText, fg: spanFg, bg: spanBg }
        if (spanBold) span.bold = true
        if (spanItalic) span.italic = true
        if (spanUnderline) span.underline = true
        row.push(span)
      }

      lines.push(row)
    }

    return {
      type: 'snapshot',
      sessionId,
      cols,
      rows,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const session of this.sessions.values()) {
      session.terminal.dispose()
    }
    this.sessions.clear()
    this.dirtySet.clear()
    this.lastSnapshotTime.clear()
  }
}
