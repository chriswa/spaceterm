package main

// --- Client → Daemon requests ---

// CreateRequest asks the daemon to spawn a new PTY session.
// The server assigns the session ID. Env must be the FULL environment
// (not inherited from daemon), including TERM=xterm-256color.
type CreateRequest struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Cwd     string            `json:"cwd"`
	Env     map[string]string `json:"env"`
	Cols    int               `json:"cols"`
	Rows    int               `json:"rows"`
}

// WriteRequest sends input data to a PTY.
type WriteRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Data string `json:"data"`
}

// ResizeRequest changes the PTY window size.
type ResizeRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// DestroyRequest kills a PTY session.
type DestroyRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// ListRequest asks for all sessions (alive and recently dead).
type ListRequest struct {
	Type string `json:"type"`
}

// AttachRequest subscribes the client to a session's output.
// The response includes the ring buffer contents for replay.
type AttachRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// DetachRequest unsubscribes the client from a session's output.
type DetachRequest struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// --- Daemon → Client responses ---

// CreatedResponse confirms a session was created.
// The creator is auto-attached.
type CreatedResponse struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Pid  int    `json:"pid"`
}

// ErrorResponse reports an error for a request.
type ErrorResponse struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	ID      string `json:"id,omitempty"`
}

// DataEvent delivers live PTY output to attached clients.
type DataEvent struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Data string `json:"data"`
}

// ExitEvent reports that a PTY session's child process exited.
type ExitEvent struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	ExitCode int    `json:"exitCode"`
	Pid      int    `json:"pid"`
}

// ListResponse returns all known sessions.
type ListResponse struct {
	Type     string        `json:"type"`
	Sessions []SessionInfo `json:"sessions"`
}

// SessionInfo describes a single PTY session.
type SessionInfo struct {
	ID       string `json:"id"`
	Pid      int    `json:"pid"`
	Cols     int    `json:"cols"`
	Rows     int    `json:"rows"`
	Alive    bool   `json:"alive"`
	ExitCode int    `json:"exitCode"`
}

// AttachedResponse confirms attachment and provides ring buffer contents.
type AttachedResponse struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Scrollback string `json:"scrollback"`
}
