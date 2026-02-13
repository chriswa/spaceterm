# Potential UTF-8 Bug Fix

## Problem

xterm.js decodes UTF-8 before parsing escape sequences. When Claude Code (or any application) sends a broken multi-byte sequence with an ANSI escape code in the middle, xterm.js can misinterpret the ESC byte (0x1B) as a UTF-8 continuation byte. This corrupts the character, the escape sequence never reaches the parser, and cursor position tracking gets thrown off for the rest of the line.

Native terminals like Ghostty handle this by decoding UTF-8 and detecting control characters simultaneously — ESC always stops UTF-8 decoding immediately. xterm.js can't do this architecturally.

## Solution: Pre-processing UTF-8 Sanitizer

Add a thin layer before `term.write()` that:

1. **Buffers incomplete trailing bytes** — If a data chunk ends mid-multi-byte-sequence, hold those bytes and prepend them to the next chunk instead of letting xterm.js see a partial sequence.

2. **Detects ESC bytes inside expected UTF-8 continuation ranges** — If we're expecting continuation bytes (0x80-0xBF) for an in-progress multi-byte character and instead get an ESC (0x1B), flush the partial sequence as U+FFFD replacement character(s), then let the ESC byte through cleanly so the escape sequence parser can handle it.

This is essentially what Ghostty does at the SIMD level (`utf8DecodeUntilControlSeq()`), but implemented in JS as a preprocessing step.

### Where to Hook In

In `TerminalCard.tsx`, the data handler currently does:

```ts
const cleanupData = window.api.pty.onData(sessionId, (data) => {
  term.write(data)
})
```

The sanitizer would sit between `onData` and `term.write()`. Also worth switching to `Uint8Array` writes at the same time, since the binary path uses `Utf8ToUtf32` which handles split multi-byte sequences across chunk boundaries better (~44% throughput improvement).

## Note: Grapheme Cluster Addon

There's an experimental `@xterm/addon-unicode-graphemes` that adds grapheme cluster support and mode 2027 negotiation. As of late 2024 it wasn't published to npm — check if that's changed. This would improve width calculation for compound emoji and other complex grapheme clusters, reducing cursor desync with programs that use Unicode-aware width calculation.

Also ensure the `@xterm/addon-unicode11` is loaded (currently missing) — without it, xterm.js defaults to Unicode 6.0 width tables.
