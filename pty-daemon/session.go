package main

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// Session represents a single PTY process managed by the daemon.
type Session struct {
	ID       string
	Cmd      *exec.Cmd
	Pty      *os.File
	Ring     *RingBuffer
	Pid      int
	Cols     int
	Rows     int
	Alive    bool
	ExitCode int
	ExitedAt time.Time // zero if still alive
	mu       sync.Mutex
}

// SessionManager owns all PTY sessions and dispatches events to clients.
type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	onData   func(sessionID string, data string)
	onExit   func(sessionID string, exitCode int, pid int)
}

func NewSessionManager(
	onData func(string, string),
	onExit func(string, int, int),
) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		onData:   onData,
		onExit:   onExit,
	}
}

// Create spawns a new PTY session with the given parameters.
func (sm *SessionManager) Create(req CreateRequest) (*Session, error) {
	cmd := exec.Command(req.Command, req.Args...)
	cmd.Dir = req.Cwd

	// Build environment from the explicit map (not inherited from daemon).
	env := make([]string, 0, len(req.Env))
	for k, v := range req.Env {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

	winSize := &pty.Winsize{
		Cols: uint16(req.Cols),
		Rows: uint16(req.Rows),
	}
	ptmx, err := pty.StartWithSize(cmd, winSize)
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}

	sess := &Session{
		ID:    req.ID,
		Cmd:   cmd,
		Pty:   ptmx,
		Ring:  NewRingBuffer(DefaultRingSize),
		Pid:   cmd.Process.Pid,
		Cols:  req.Cols,
		Rows:  req.Rows,
		Alive: true,
	}

	sm.mu.Lock()
	sm.sessions[req.ID] = sess
	sm.mu.Unlock()

	// Read PTY output in a goroutine.
	go func() {
		buf := make([]byte, 32*1024) // 32KB read buffer
		var pending []byte            // incomplete UTF-8 tail from previous read
		for {
			n, err := ptmx.Read(buf)
			if n > 0 {
				// Combine any pending incomplete UTF-8 bytes with new data.
				var chunk []byte
				if len(pending) > 0 {
					chunk = make([]byte, len(pending)+n)
					copy(chunk, pending)
					copy(chunk[len(pending):], buf[:n])
					pending = nil
				} else {
					chunk = buf[:n]
				}

				// Hold back any trailing incomplete UTF-8 sequence so it
				// doesn't get split across JSON messages and mangled into
				// U+FFFD by json.Marshal.
				tail := incompleteUTF8Tail(chunk)
				if tail > 0 {
					pending = make([]byte, tail)
					copy(pending, chunk[len(chunk)-tail:])
					chunk = chunk[:len(chunk)-tail]
				}

				if len(chunk) > 0 {
					data := string(chunk)
					sess.Ring.Write(chunk)
					sm.onData(req.ID, data)
				}
			}
			if err != nil {
				// Flush any remaining pending bytes on EOF.
				if len(pending) > 0 {
					data := string(pending)
					sess.Ring.Write(pending)
					sm.onData(req.ID, data)
				}
				break
			}
		}
		// Wait for process to fully exit.
		state, _ := cmd.Process.Wait()
		exitCode := 0
		if state != nil {
			exitCode = state.ExitCode()
		}
		pid := sess.Pid
		sess.mu.Lock()
		sess.Alive = false
		sess.ExitCode = exitCode
		sess.ExitedAt = time.Now()
		sess.mu.Unlock()
		sm.onExit(req.ID, exitCode, pid)
	}()

	return sess, nil
}

// Write sends input data to a PTY.
func (sm *SessionManager) Write(id string, data string) error {
	sm.mu.RLock()
	sess, ok := sm.sessions[id]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}
	_, err := sess.Pty.Write([]byte(data))
	return err
}

// Resize changes the PTY window size.
func (sm *SessionManager) Resize(id string, cols, rows int) error {
	sm.mu.RLock()
	sess, ok := sm.sessions[id]
	sm.mu.RUnlock()
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}
	sess.mu.Lock()
	sess.Cols = cols
	sess.Rows = rows
	sess.mu.Unlock()
	return pty.Setsize(sess.Pty, &pty.Winsize{
		Cols: uint16(cols),
		Rows: uint16(rows),
	})
}

// Destroy kills a PTY session and removes it.
func (sm *SessionManager) Destroy(id string) {
	sm.mu.Lock()
	sess, ok := sm.sessions[id]
	if !ok {
		sm.mu.Unlock()
		return
	}
	delete(sm.sessions, id)
	sm.mu.Unlock()

	if sess.Alive {
		_ = sess.Cmd.Process.Signal(syscall.SIGHUP)
		sess.Pty.Close()
	}
}

// DestroyAll kills all sessions. Used during daemon shutdown.
func (sm *SessionManager) DestroyAll() {
	sm.mu.Lock()
	ids := make([]string, 0, len(sm.sessions))
	for id := range sm.sessions {
		ids = append(ids, id)
	}
	sm.mu.Unlock()
	for _, id := range ids {
		sm.Destroy(id)
	}
}

// List returns info about all known sessions.
func (sm *SessionManager) List() []SessionInfo {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	out := make([]SessionInfo, 0, len(sm.sessions))
	for _, s := range sm.sessions {
		s.mu.Lock()
		out = append(out, SessionInfo{
			ID:       s.ID,
			Pid:      s.Pid,
			Cols:     s.Cols,
			Rows:     s.Rows,
			Alive:    s.Alive,
			ExitCode: s.ExitCode,
		})
		s.mu.Unlock()
	}
	return out
}

// GetScrollback returns the ring buffer contents as a string.
func (sm *SessionManager) GetScrollback(id string) (string, error) {
	sm.mu.RLock()
	sess, ok := sm.sessions[id]
	sm.mu.RUnlock()
	if !ok {
		return "", fmt.Errorf("session not found: %s", id)
	}
	return string(sess.Ring.Contents()), nil
}

// SweepDead removes sessions that have been dead for longer than maxAge.
func (sm *SessionManager) SweepDead(maxAge time.Duration) int {
	now := time.Now()
	sm.mu.Lock()
	defer sm.mu.Unlock()

	swept := 0
	for id, s := range sm.sessions {
		s.mu.Lock()
		dead := !s.Alive && !s.ExitedAt.IsZero() && now.Sub(s.ExitedAt) > maxAge
		s.mu.Unlock()
		if dead {
			delete(sm.sessions, id)
			swept++
		}
	}
	return swept
}
