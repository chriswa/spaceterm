# ANSI Preservation Bug

## Symptom

The snapshot (rendered from the server's headless xterm) displays correctly, but the client-side xterm has elements in wrong positions, wrong colors, or garbled layout. The divergence is intermittent and gets worse over time, especially with react-ink applications that do frequent full-screen redraws.

## Root Cause

`ScrollbackBuffer` (`src/server/scrollback-buffer.ts`) truncates raw terminal output at a string boundary without preserving the ANSI state that was in effect at the truncation point.

When the buffer exceeds 1MB, it trims to 512KB:

```typescript
// scrollback-buffer.ts:13-23
if (this.totalLength > MAX_SIZE) {
  const joined = this.chunks.join('')
  let cutPoint = joined.length - TRIM_TARGET
  const scanEnd = Math.min(cutPoint + NEWLINE_SCAN_LIMIT, joined.length)
  const newlineIndex = joined.indexOf('\n', cutPoint)
  if (newlineIndex !== -1 && newlineIndex < scanEnd) {
    cutPoint = newlineIndex + 1
  }
  this.chunks = [joined.slice(cutPoint)]
  this.totalLength = this.chunks[0].length
}
```

The truncation finds a newline boundary but does not account for ANSI state at the cut point. Any terminal state that was set before the cut point and still in effect after it is silently lost.

## Why the Server Headless xterm Is Unaffected

The `SnapshotManager` (`src/server/snapshot-manager.ts`) feeds ALL PTY data to its headless xterm instance with no truncation:

```typescript
// snapshot-manager.ts:44-48
write(sessionId: string, data: string): void {
  const session = this.sessions.get(sessionId)
  if (!session) return
  session.terminal.write(data)
  this.dirtySet.add(sessionId)
}
```

The headless xterm has `scrollback: 0` (line 29), so it only keeps the visible viewport, but its internal ANSI parser state is always correct because it has processed every byte from the PTY since session creation. Snapshots are serialized from this buffer state (`serializeSession`), so they are always accurate.

## What State Can Be Lost

The following ANSI state is cumulative (set once, stays in effect until explicitly changed) and can be active at the truncation point:

### SGR (Select Graphic Rendition) attributes
- Foreground/background colors: `\x1b[38;2;R;G;Bm`, `\x1b[48;5;Nm`, `\x1b[31m`, etc.
- Bold, italic, underline, inverse, strikethrough: `\x1b[1m`, `\x1b[3m`, `\x1b[4m`, etc.
- These persist until `\x1b[0m` (reset) or an explicit attribute change.

### Cursor state
- Saved cursor position: `\x1b[s` (save) / `\x1b[u` (restore). If `save` was before the cut point and `restore` is after, the restore targets a stale/default position.
- Cursor visibility: `\x1b[?25l` (hide) / `\x1b[?25h` (show).

### Screen buffer mode
- Alternate screen buffer: `\x1b[?1049h` (enter) / `\x1b[?1049l` (leave). If the enter sequence is cut, the client stays in the main buffer while the PTY is writing to the alternate buffer. All subsequent cursor positioning is wrong.

### Scroll region
- `\x1b[T;Br` sets the scroll region to rows T..B. If this is cut, the client uses the full screen as the scroll region, causing content to appear in wrong rows.

### Character set / encoding
- `\x1b(0` switches to DEC line-drawing character set (used for box-drawing). If cut, subsequent box-drawing characters render as ASCII letters (e.g., `q` instead of `─`).

### Bracketed paste mode
- `\x1b[?2004h` (enable). Not visible but affects how paste input is framed.

### Mouse reporting mode
- `\x1b[?1000h`, `\x1b[?1003h`, etc. If cut, the client doesn't send mouse events that the PTY application expects.

## The Butterfly Effect

When any of the above state is lost at the truncation point:

1. The client xterm starts from default state when replaying the truncated scrollback.
2. Data after the cut point was emitted by the PTY assuming the lost state is active.
3. Every subsequent terminal operation (cursor move, text write, color change) is interpreted in the wrong context.
4. The error compounds with each frame because react-ink's redraws use relative positioning and assume the prior frame's state.

Example cascade:
- PTY sets scroll region to rows 2-24 (for a react-ink layout with a header).
- Truncation discards the scroll region command.
- Client uses default scroll region (full screen).
- React-ink writes content to row 25 expecting it to scroll within rows 2-24.
- On the client, the scroll affects the entire screen, pushing the header off-screen.
- Every subsequent frame paints content in the wrong rows.

## Why React-Ink Makes This Worse

React-ink applications:
- Do full-screen redraws at high frequency (every state change, often 10-60fps).
- Use absolute cursor positioning (`\x1b[<row>;<col>H`) relative to the scroll region.
- Set colors and attributes at the start of a render cycle, then emit styled text.
- May use the alternate screen buffer for full-screen layouts.
- Generate large volumes of output quickly, making 1MB truncation threshold reachable.

A single lost state-setting sequence at the truncation point corrupts every subsequent frame rendered by react-ink.

## Data Flow Reference

```
node-pty (PTY)
  │
  ├──→ ScrollbackBuffer.write(data)     // accumulates raw bytes, truncates at 1MB
  │      └── getContents() → replayed to client on attach
  │
  ├──→ SnapshotManager.write(data)      // headless xterm, no truncation, always correct
  │      └── serializeSession() → snapshot sent to unfocused clients
  │
  └──→ broadcastToAttached(data)        // live data stream to focused clients
```

The client xterm receives: `scrollback replay + live data stream`. If the scrollback is truncated, the replay starts with missing state, and all subsequent live data is interpreted incorrectly.

## Possible Fixes

### Option A: Prepend a terminal reset to truncated scrollback

When truncation occurs, prepend `\x1bc` (RIS — Reset to Initial State) to the remaining data. This ensures the client starts from a known default state. Downside: any state that WAS correctly set after the cut point gets reset too, and may not be re-established until the next full redraw by the application.

### Option B: Query headless xterm state at truncation time

When the scrollback needs to be replayed to a client, instead of sending raw truncated bytes, ask the `SnapshotManager`'s headless xterm for its current ANSI state and prepend the equivalent setup sequences to the truncated scrollback. This is the most correct approach but requires extracting state from xterm.js (cursor position, active attributes, scroll region, buffer mode, etc.).

### Option C: Use snapshot as the starting point

Instead of replaying raw scrollback, render the current snapshot into ANSI sequences (reverse the serialization) and send that as the "scrollback". This guarantees the client starts with the exact screen state the server has. The client would then receive live data on top of a correct starting state. Downside: loses scrollback history (the client only gets the current viewport, no scroll-up).

### Option D: Hybrid — snapshot + bounded raw tail

Send the snapshot (converted to ANSI) as the initial state, then append a bounded tail of raw scrollback (e.g., last 100KB) for scroll-up history. The snapshot ensures correct visible state; the raw tail provides some history. The raw tail may have ANSI state issues, but only affects content that the user scrolls up to view, not the active viewport.

## Related: Separate Race Condition

There is also a race condition where live data is written to the client xterm before the scrollback is replayed (see `TerminalCard.tsx:380` vs `:358`). That bug is independent of this one but compounds the symptoms. Even if the scrollback were perfectly preserved, the race condition alone can cause garbled output.
