package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Client represents a single connection to the daemon.
type Client struct {
	conn     net.Conn
	mu       sync.Mutex
	attached map[string]bool // session IDs this client receives output for
	encoder  *json.Encoder
}

// Send writes a JSON message to the client. Thread-safe.
func (c *Client) Send(msg interface{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.encoder.Encode(msg) //nolint: encoder writes to socket, errors handled by disconnect
}

var (
	clientsMu sync.Mutex
	clients   = make(map[*Client]bool)
)

// broadcastToAttached sends a message to all clients attached to a session.
func broadcastToAttached(sessionID string, msg interface{}) {
	clientsMu.Lock()
	defer clientsMu.Unlock()
	for c := range clients {
		if c.attached[sessionID] {
			c.Send(msg)
		}
	}
}

// runDaemon is the main daemon loop. Called by `pty-daemon run`.
func runDaemon() {
	// Set up logging.
	logFile, err := os.OpenFile(logPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to open log file: %v\n", err)
		os.Exit(1)
	}
	log.SetOutput(logFile)
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	// Write PID file.
	os.MkdirAll(socketDir(), 0755)
	os.WriteFile(pidPath(), []byte(fmt.Sprintf("%d", os.Getpid())), 0644)
	log.Printf("Daemon starting (pid %d)", os.Getpid())

	// Remove stale socket.
	os.Remove(socketPath())

	// Initialize session manager with broadcast callbacks.
	sm := NewSessionManager(
		func(sessionID string, data string) {
			broadcastToAttached(sessionID, DataEvent{
				Type: "data",
				ID:   sessionID,
				Data: data,
			})
		},
		func(sessionID string, exitCode int, pid int) {
			log.Printf("Session exited: %s (pid %d, code %d)", sessionID, pid, exitCode)
			broadcastToAttached(sessionID, ExitEvent{
				Type:     "exit",
				ID:       sessionID,
				ExitCode: exitCode,
				Pid:      pid,
			})
		},
	)

	// Dead session sweeper: every 60s, remove sessions dead for >5 minutes.
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if n := sm.SweepDead(5 * time.Minute); n > 0 {
				log.Printf("Swept %d dead session(s)", n)
			}
		}
	}()

	// Listen on Unix domain socket.
	ln, err := net.Listen("unix", socketPath())
	if err != nil {
		log.Fatalf("Failed to listen on %s: %v", socketPath(), err)
	}
	// Make socket accessible only to owner.
	os.Chmod(socketPath(), 0600)
	log.Printf("Listening on %s", socketPath())

	// Graceful shutdown.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("Received %s, shutting down", sig)
		ln.Close()
		sm.DestroyAll()
		os.Remove(socketPath())
		os.Remove(pidPath())
		log.Printf("Daemon stopped")
		os.Exit(0)
	}()

	// Accept connections.
	for {
		conn, err := ln.Accept()
		if err != nil {
			break // Listener closed (shutdown).
		}
		go handleClient(conn, sm)
	}
}

func handleClient(conn net.Conn, sm *SessionManager) {
	client := &Client{
		conn:     conn,
		attached: make(map[string]bool),
		encoder:  json.NewEncoder(conn),
	}

	clientsMu.Lock()
	clients[client] = true
	clientsMu.Unlock()

	defer func() {
		clientsMu.Lock()
		delete(clients, client)
		clientsMu.Unlock()
		conn.Close()
	}()

	scanner := bufio.NewScanner(conn)
	// Allow lines up to 2MB (large env maps, scrollback requests).
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		// Peek at the "type" field to dispatch.
		var peek struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(line, &peek); err != nil {
			client.Send(ErrorResponse{Type: "error", Message: "malformed JSON"})
			continue
		}

		switch peek.Type {
		case "create":
			var req CreateRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			sess, err := sm.Create(req)
			if err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: req.ID})
				continue
			}
			log.Printf("Session created: %s (pid %d, %dx%d, cmd=%s)", req.ID, sess.Pid, req.Cols, req.Rows, req.Command)
			// Auto-attach the creator.
			client.attached[req.ID] = true
			client.Send(CreatedResponse{Type: "created", ID: req.ID, Pid: sess.Pid})

		case "write":
			var req WriteRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			if err := sm.Write(req.ID, req.Data); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: req.ID})
			}

		case "resize":
			var req ResizeRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			if err := sm.Resize(req.ID, req.Cols, req.Rows); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: req.ID})
			}

		case "destroy":
			var req DestroyRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			log.Printf("Session destroyed: %s", req.ID)
			sm.Destroy(req.ID)

		case "list":
			sessions := sm.List()
			client.Send(ListResponse{Type: "listed", Sessions: sessions})

		case "attach":
			var req AttachRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			client.attached[req.ID] = true
			scrollback, err := sm.GetScrollback(req.ID)
			if err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: req.ID})
				continue
			}
			client.Send(AttachedResponse{Type: "attached", ID: req.ID, Scrollback: scrollback})

		case "detach":
			var req DetachRequest
			if err := json.Unmarshal(line, &req); err != nil {
				client.Send(ErrorResponse{Type: "error", Message: err.Error(), ID: ""})
				continue
			}
			delete(client.attached, req.ID)

		default:
			client.Send(ErrorResponse{Type: "error", Message: "unknown type: " + peek.Type})
		}
	}
}
