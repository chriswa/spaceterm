package main

import (
	"sync"
)

// incompleteUTF8Tail returns the number of trailing bytes that form an
// incomplete multi-byte UTF-8 sequence. The caller should hold these bytes
// back until more data arrives to complete the character.
func incompleteUTF8Tail(data []byte) int {
	n := len(data)
	if n == 0 || data[n-1] < 0x80 {
		return 0 // ASCII or empty — all complete
	}
	// Scan backwards (up to 3 bytes) to find the start of the last
	// multi-byte sequence. A UTF-8 start byte has the pattern 11xxxxxx;
	// continuation bytes have the pattern 10xxxxxx.
	for i := 0; i < 4 && i < n; i++ {
		b := data[n-1-i]
		if b&0xC0 != 0x80 {
			// Found a start byte. Determine expected sequence length.
			var seqLen int
			switch {
			case b&0xE0 == 0xC0:
				seqLen = 2
			case b&0xF0 == 0xE0:
				seqLen = 3
			case b&0xF8 == 0xF0:
				seqLen = 4
			default:
				return 0 // Not a valid start byte, send as-is
			}
			have := i + 1
			if have < seqLen {
				return have // Incomplete — hold back these bytes
			}
			return 0 // Complete sequence
		}
	}
	// 4+ continuation bytes in a row — invalid UTF-8, send as-is
	return 0
}

// skipLeadingContinuationBytes skips orphaned UTF-8 continuation bytes
// (10xxxxxx) at the start of data. These occur when a ring buffer wrap
// overwrites the start byte of a multi-byte character.
func skipLeadingContinuationBytes(data []byte) []byte {
	i := 0
	for i < len(data) && i < 4 && data[i]&0xC0 == 0x80 {
		i++
	}
	return data[i:]
}

// DefaultRingSize is 1MB, matching the server's ScrollbackBuffer max.
const DefaultRingSize = 1024 * 1024

// RingBuffer is a thread-safe circular byte buffer.
// Oldest data is silently overwritten when the buffer is full.
type RingBuffer struct {
	mu   sync.Mutex
	buf  []byte
	size int
	pos  int  // next write position
	full bool // buffer has wrapped at least once
}

func NewRingBuffer(size int) *RingBuffer {
	return &RingBuffer{buf: make([]byte, size), size: size}
}

// Write appends data to the ring buffer.
func (r *RingBuffer) Write(data []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for len(data) > 0 {
		n := copy(r.buf[r.pos:], data)
		data = data[n:]
		r.pos += n
		if r.pos >= r.size {
			r.pos = 0
			r.full = true
		}
	}
}

// Contents returns the ring buffer contents in order (oldest first).
// If the buffer has wrapped, leading orphaned UTF-8 continuation bytes
// are skipped so the output starts on a valid character boundary.
// Returns a new slice that the caller owns.
func (r *RingBuffer) Contents() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()

	if !r.full {
		out := make([]byte, r.pos)
		copy(out, r.buf[:r.pos])
		return out
	}
	// Buffer has wrapped: [pos..size) is oldest, [0..pos) is newest.
	// The wrap point may have split a multi-byte UTF-8 character, so
	// the oldest data can start with orphaned continuation bytes.
	out := make([]byte, r.size)
	n := copy(out, r.buf[r.pos:])
	copy(out[n:], r.buf[:r.pos])
	return skipLeadingContinuationBytes(out)
}
