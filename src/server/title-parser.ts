const enum State {
  Idle,
  GotEsc,
  GotBracket,
  CollectDigit,
  CollectPayload,
}

/**
 * Stateful parser that scans pty data chunks for OSC 0/2 title sequences
 * and OSC 7 CWD sequences. Handles sequences split across chunks.
 *
 * OSC format: ESC ] <0|2|7> ; <text> <BEL|ST>
 *   BEL = \x07
 *   ST  = ESC \
 */
export class TitleParser {
  onTitle: (title: string) => void
  onCwd: (cwd: string) => void

  private state: State = State.Idle
  private oscCode = 0
  private buf = ''

  constructor(onTitle: (title: string) => void, onCwd: (cwd: string) => void) {
    this.onTitle = onTitle
    this.onCwd = onCwd
  }

  write(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]

      switch (this.state) {
        case State.Idle:
          if (ch === '\x1b') {
            this.state = State.GotEsc
          }
          break

        case State.GotEsc:
          if (ch === ']') {
            this.state = State.GotBracket
            this.oscCode = 0
            this.buf = ''
          } else {
            this.state = State.Idle
          }
          break

        case State.GotBracket:
          if (ch >= '0' && ch <= '9') {
            this.oscCode = ch.charCodeAt(0) - 48
            this.state = State.CollectDigit
          } else {
            this.state = State.Idle
          }
          break

        case State.CollectDigit:
          if (ch === ';') {
            if (this.oscCode === 0 || this.oscCode === 2 || this.oscCode === 7) {
              this.state = State.CollectPayload
            } else {
              this.state = State.Idle
            }
          } else if (ch >= '0' && ch <= '9') {
            this.oscCode = this.oscCode * 10 + (ch.charCodeAt(0) - 48)
          } else {
            this.state = State.Idle
          }
          break

        case State.CollectPayload:
          if (ch === '\x07') {
            // BEL terminates OSC
            this.emitTitle()
            this.state = State.Idle
          } else if (ch === '\x1b') {
            // Could be start of ST (ESC \) or a new ESC sequence
            if (i + 1 < data.length && data[i + 1] === '\\') {
              // ST terminates OSC
              i++ // consume the backslash
              this.emitTitle()
              this.state = State.Idle
            } else if (i + 1 < data.length) {
              // Not ST — abort this OSC and re-process as new ESC
              this.state = State.GotEsc
            } else {
              // ESC at end of chunk — we'll see the next char in the next write.
              // Buffer it and stay in CollectPayload; if next char is '\' it's ST.
              // Handle this by peeking in the next write call.
              this.buf += ch
            }
          } else {
            this.buf += ch
          }
          break
      }
    }
  }

  private emitTitle(): void {
    if (this.oscCode === 7) {
      // OSC 7: file://host/path — extract path
      try {
        const url = new URL(this.buf)
        const cwd = decodeURIComponent(url.pathname)
        if (cwd) {
          this.onCwd(cwd)
        }
      } catch {
        // Malformed URL, ignore
      }
    } else {
      const stripped = this.buf.replace(/^[^\x20-\x7E]+\s*/, '').trim()
      if (stripped) {
        this.onTitle(stripped)
      }
    }
    this.buf = ''
  }
}
