import { Terminal, type IBufferCell } from '@xterm/headless'
import type { AttrSpan, SnapshotRow, SnapshotMessage } from '../shared/protocol'
import { ANSI_COLORS, DEFAULT_FG, DEFAULT_BG, CUBE_STEPS } from '../shared/theme'

const TICK_INTERVAL = 100 // 10 ticks/sec, one dirty session per tick

export type SnapshotCallback = (snapshot: SnapshotMessage) => void

interface HeadlessSession {
  sessionId: string
  terminal: Terminal
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
    const terminal = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
    this.sessions.set(sessionId, { sessionId, terminal, cols, rows })
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

    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(y)
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
        const fg = this.resolveFg(cell)
        const bg = this.resolveBg(cell)
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

  private resolveFg(cell: IBufferCell): string {
    try {
      const fgColor = cell.getFgColor()
      if (cell.isFgRGB()) {
        // True color (24-bit)
        const r = (fgColor >> 16) & 0xFF
        const g = (fgColor >> 8) & 0xFF
        const b = fgColor & 0xFF
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
      }
      if (cell.isFgPalette()) {
        const idx = fgColor
        if (idx >= 0 && idx < 16) return ANSI_COLORS[idx]
        // 256-color palette: just return a reasonable approximation
        if (idx >= 16 && idx < 232) {
          const n = idx - 16
          const r = CUBE_STEPS[Math.floor(n / 36) % 6]
          const g = CUBE_STEPS[Math.floor((n % 36) / 6)]
          const b = CUBE_STEPS[n % 6]
          return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
        }
        if (idx >= 232 && idx < 256) {
          const grey = (idx - 232) * 10 + 8
          return `#${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}`
        }
      }
      if (cell.isBold && cell.isBold() && fgColor >= 0 && fgColor < 8) {
        return ANSI_COLORS[fgColor + 8]
      }
    } catch {
      // fallthrough
    }
    return DEFAULT_FG
  }

  private resolveBg(cell: IBufferCell): string {
    try {
      const bgColor = cell.getBgColor()
      if (cell.isBgRGB()) {
        const r = (bgColor >> 16) & 0xFF
        const g = (bgColor >> 8) & 0xFF
        const b = bgColor & 0xFF
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
      }
      if (cell.isBgPalette()) {
        const idx = bgColor
        if (idx >= 0 && idx < 16) return ANSI_COLORS[idx]
        if (idx >= 16 && idx < 232) {
          const n = idx - 16
          const r = CUBE_STEPS[Math.floor(n / 36) % 6]
          const g = CUBE_STEPS[Math.floor((n % 36) / 6)]
          const b = CUBE_STEPS[n % 6]
          return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
        }
        if (idx >= 232 && idx < 256) {
          const grey = (idx - 232) * 10 + 8
          return `#${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}${grey.toString(16).padStart(2, '0')}`
        }
      }
    } catch {
      // fallthrough
    }
    return DEFAULT_BG
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
