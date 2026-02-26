package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRingBuffer_UnderSize(t *testing.T) {
	r := NewRingBuffer(16)
	r.Write([]byte("hello"))
	got := r.Contents()
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("expected 'hello', got %q", got)
	}
}

func TestRingBuffer_ExactSize(t *testing.T) {
	r := NewRingBuffer(5)
	r.Write([]byte("abcde"))
	got := r.Contents()
	if !bytes.Equal(got, []byte("abcde")) {
		t.Fatalf("expected 'abcde', got %q", got)
	}
}

func TestRingBuffer_Wrap(t *testing.T) {
	r := NewRingBuffer(5)
	r.Write([]byte("abcde"))
	r.Write([]byte("fg"))
	got := r.Contents()
	// Should contain the most recent 5 bytes: "cdefg"
	if !bytes.Equal(got, []byte("cdefg")) {
		t.Fatalf("expected 'cdefg', got %q", got)
	}
}

func TestRingBuffer_MultipleWraps(t *testing.T) {
	r := NewRingBuffer(4)
	r.Write([]byte("abcdefghijklmnop"))
	got := r.Contents()
	if !bytes.Equal(got, []byte("mnop")) {
		t.Fatalf("expected 'mnop', got %q", got)
	}
}

func TestRingBuffer_Empty(t *testing.T) {
	r := NewRingBuffer(16)
	got := r.Contents()
	if len(got) != 0 {
		t.Fatalf("expected empty, got %q", got)
	}
}

func TestRingBuffer_IncrementalWrites(t *testing.T) {
	r := NewRingBuffer(6)
	r.Write([]byte("ab"))
	r.Write([]byte("cd"))
	r.Write([]byte("ef"))
	r.Write([]byte("gh"))
	got := r.Contents()
	// 6-byte buffer, wrote 8 bytes total: should have "cdefgh"
	if !bytes.Equal(got, []byte("cdefgh")) {
		t.Fatalf("expected 'cdefgh', got %q", got)
	}
}

// ── UTF-8 helper tests ──────────────────────────────────────────────

func TestIncompleteUTF8Tail_ASCII(t *testing.T) {
	if n := incompleteUTF8Tail([]byte("hello")); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Empty(t *testing.T) {
	if n := incompleteUTF8Tail(nil); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Complete2Byte(t *testing.T) {
	// é = U+00E9 = C3 A9
	if n := incompleteUTF8Tail([]byte("caf\xc3\xa9")); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Incomplete2Byte(t *testing.T) {
	// C3 alone is the start of a 2-byte sequence
	if n := incompleteUTF8Tail([]byte("caf\xc3")); n != 1 {
		t.Fatalf("expected 1, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Complete3Byte(t *testing.T) {
	// ─ = U+2500 = E2 94 80
	if n := incompleteUTF8Tail([]byte("ab\xe2\x94\x80")); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Incomplete3Byte_1of3(t *testing.T) {
	// E2 alone: start of 3-byte, missing 2 continuation bytes
	if n := incompleteUTF8Tail([]byte("ab\xe2")); n != 1 {
		t.Fatalf("expected 1, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Incomplete3Byte_2of3(t *testing.T) {
	// E2 94: start of 3-byte, have 1 continuation, missing 1
	if n := incompleteUTF8Tail([]byte("ab\xe2\x94")); n != 2 {
		t.Fatalf("expected 2, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Complete4Byte(t *testing.T) {
	// 😀 = U+1F600 = F0 9F 98 80
	if n := incompleteUTF8Tail([]byte("hi\xf0\x9f\x98\x80")); n != 0 {
		t.Fatalf("expected 0, got %d", n)
	}
}

func TestIncompleteUTF8Tail_Incomplete4Byte(t *testing.T) {
	// F0 9F 98: 3 of 4 bytes
	if n := incompleteUTF8Tail([]byte("hi\xf0\x9f\x98")); n != 3 {
		t.Fatalf("expected 3, got %d", n)
	}
}

func TestSkipLeadingContinuationBytes(t *testing.T) {
	// 94 80 are orphaned continuations from a split ─ (E2 94 80)
	data := []byte{0x94, 0x80, 'h', 'e', 'l', 'l', 'o'}
	got := skipLeadingContinuationBytes(data)
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("expected 'hello', got %q", got)
	}
}

func TestSkipLeadingContinuationBytes_NoneToSkip(t *testing.T) {
	data := []byte("hello")
	got := skipLeadingContinuationBytes(data)
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("expected 'hello', got %q", got)
	}
}

func TestRingBuffer_WrapSkipsOrphanedUTF8(t *testing.T) {
	// Buffer size 8. Write "hello" (5 bytes) then "─X" (E2 94 80 58 = 4 bytes).
	// Total 9 bytes into 8-byte buffer: wraps, oldest byte (h) is overwritten.
	// Contents raw would be: [e l l o E2 94 80 58]
	// No orphaned bytes — should get "ello─X".
	r := NewRingBuffer(8)
	r.Write([]byte("hello"))
	r.Write([]byte("─X")) // ─ is E2 94 80
	got := string(r.Contents())
	if got != "ello─X" {
		t.Fatalf("expected 'ello─X', got %q", got)
	}
}

func TestRingBuffer_WrapSplitsUTF8(t *testing.T) {
	// Buffer size 6. Write "abcde" (5 bytes) then "─" (E2 94 80 = 3 bytes).
	// Total 8 bytes into 6-byte buffer.
	// After writes, raw ring is: [94 80 c d e E2] (pos=2, wrapped)
	// Contents() reassembles: [c d e E2 94 80] = "cde─" — E2 starts the newest part.
	// Actually wait: let me trace carefully.
	// Write "abcde" (5 bytes): buf=[a b c d e _], pos=5, full=false
	// Write "─" = E2 94 80 (3 bytes):
	//   copy(buf[5:], [E2 94 80]) → copies 1 byte: buf=[a b c d e E2], pos=6→0, full=true
	//   copy(buf[0:], [94 80]) → copies 2 bytes: buf=[94 80 c d e E2], pos=2
	// Contents (wrapped): oldest = buf[2:] = [c d e E2], newest = buf[:2] = [94 80]
	// Assembled: [c d e E2 94 80] = "cde─" ← all complete, no orphans!
	r := NewRingBuffer(6)
	r.Write([]byte("abcde"))
	r.Write([]byte("─"))
	got := string(r.Contents())
	if got != "cde─" {
		t.Fatalf("expected 'cde─', got %q", got)
	}
}

func TestRingBuffer_WrapOrphansLeadingContinuation(t *testing.T) {
	// Deliberately construct a case where wrap splits a 3-byte char.
	// Buffer size 5. Write "abc─" = [61 62 63 E2 94 80] (6 bytes).
	// copy(buf[0:], first 5) → buf=[61 62 63 E2 94], pos=5→0, full=true
	// copy(buf[0:], last 1) → buf=[80 62 63 E2 94], pos=1
	// Contents (wrapped): oldest=buf[1:]=[62 63 E2 94], newest=buf[:1]=[80]
	// Assembled: [62 63 E2 94 80] = "bc─" ← actually complete! The wrap
	// happened to leave the 80 in newest and E2 94 in oldest.
	// Hmm, let me try a different split.
	//
	// Buffer size 4. Write "ab─" = [61 62 E2 94 80] (5 bytes).
	// copy(buf[0:], first 4) → buf=[61 62 E2 94], pos=4→0, full=true
	// copy(buf[0:], last 1) → buf=[80 62 E2 94], pos=1
	// Contents (wrapped): oldest=buf[1:]=[62 E2 94], newest=buf[:1]=[80]
	// Assembled: [62 E2 94 80] = "b─" ← still complete!
	//
	// To get orphaned bytes, we need the start byte to be overwritten.
	// Buffer size 4. Write "abc─" = [61 62 63 E2 94 80] (6 bytes).
	// copy(buf[0:], first 4) → buf=[61 62 63 E2], pos=4→0, full=true
	// copy(buf[0:], last 2) → buf=[94 80 63 E2], pos=2
	// Contents (wrapped): oldest=buf[2:]=[63 E2], newest=buf[:2]=[94 80]
	// Assembled: [63 E2 94 80] = "c─" ← E2 is in the oldest part, still valid!
	//
	// We need the E2 to be overwritten. Buffer size 3.
	// Write "ab─" = [61 62 E2 94 80] (5 bytes).
	// copy(buf[0:], first 3) → buf=[61 62 E2], pos=3→0, full=true
	// copy(buf[0:], next 2) → buf=[94 80 E2], pos=2
	// Contents (wrapped): oldest=buf[2:]=[E2], newest=buf[:2]=[94 80]
	// Assembled: [E2 94 80] = "─" ← still a complete char!
	//
	// Trickier: Buffer size 3, write "a─b" = [61 E2 94 80 62] (5 bytes).
	// copy(buf[0:], first 3) → buf=[61 E2 94], pos=3→0, full=true
	// copy(buf[0:], next 2) → buf=[80 62 94], pos=2
	// Contents (wrapped): oldest=buf[2:]=[94], newest=buf[:2]=[80 62]
	// Assembled: [94 80 62] → starts with continuation bytes 94, 80 → skip → "b"
	r := NewRingBuffer(3)
	r.Write([]byte("a\xe2\x94\x80b")) // "a─b"
	got := string(r.Contents())
	if got != "b" {
		t.Fatalf("expected 'b', got %q (% x)", got, r.Contents())
	}
}

func TestRingBuffer_WrapOrphans2ByteChar(t *testing.T) {
	// Buffer size 3. Write "aéb" = [61 C3 A9 62] (4 bytes).
	// copy(buf[0:], first 3) → buf=[61 C3 A9], pos=3→0, full=true
	// copy(buf[0:], last 1) → buf=[62 C3 A9], pos=1
	// Contents (wrapped): oldest=buf[1:]=[C3 A9], newest=buf[:1]=[62]
	// Assembled: [C3 A9 62] = "éb" ← complete!
	//
	// Buffer size 2. Write "éb" = [C3 A9 62] (3 bytes).
	// copy(buf[0:], first 2) → buf=[C3 A9], pos=2→0, full=true
	// copy(buf[0:], last 1) → buf=[62 A9], pos=1
	// Contents (wrapped): oldest=buf[1:]=[A9], newest=buf[:1]=[62]
	// Assembled: [A9 62] → starts with continuation A9 → skip → "b"
	r := NewRingBuffer(2)
	r.Write([]byte("\xc3\xa9b")) // "éb"
	got := string(r.Contents())
	if got != "b" {
		t.Fatalf("expected 'b', got %q", got)
	}
}

func TestIncompleteUTF8Tail_BoxDrawingLine(t *testing.T) {
	// Simulate a long line of box-drawing chars split at a read boundary.
	// ─ = E2 94 80, repeated. Split after the E2 of the last char.
	line := strings.Repeat("─", 100) // 300 bytes
	data := []byte(line)
	// Chop off last 2 bytes to simulate incomplete final ─
	chopped := data[:len(data)-2] // ends with E2
	if n := incompleteUTF8Tail(chopped); n != 1 {
		t.Fatalf("expected 1 (lone E2 start byte), got %d", n)
	}
	// Chop off last byte
	chopped2 := data[:len(data)-1] // ends with E2 94
	if n := incompleteUTF8Tail(chopped2); n != 2 {
		t.Fatalf("expected 2 (E2 94 without final 80), got %d", n)
	}
}
