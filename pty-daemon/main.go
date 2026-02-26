package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const (
	socketName = "pty-daemon.sock"
	pidName    = "pty-daemon.pid"
	logName    = "pty-daemon.log"
)

func socketDir() string {
	if d := os.Getenv("SPACETERM_HOME"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".spaceterm")
}

func socketPath() string { return filepath.Join(socketDir(), socketName) }
func pidPath() string    { return filepath.Join(socketDir(), pidName) }
func logPath() string    { return filepath.Join(socketDir(), logName) }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: pty-daemon <start|stop|restart|run|status>\n")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "start":
		cmdStart()
	case "stop":
		cmdStop()
	case "restart":
		cmdStop()
		cmdStart()
	case "run":
		runDaemon()
	case "status":
		cmdStatus()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func cmdStart() {
	if pid := readPid(); pid != 0 {
		if processAlive(pid) {
			fmt.Printf("Daemon already running (pid %d)\n", pid)
			return
		}
		// Stale PID file — clean up.
		os.Remove(pidPath())
	}
	// Clean stale socket.
	os.Remove(socketPath())

	// Re-exec self with "run" subcommand, detached from terminal.
	exePath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to find executable: %v\n", err)
		os.Exit(1)
	}
	cmd := exec.Command(exePath, "run")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Detach all stdio so the daemon doesn't hold the terminal open.
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start daemon: %v\n", err)
		os.Exit(1)
	}
	// Release the child so we don't become a zombie parent.
	cmd.Process.Release()

	// Wait for the socket to appear (up to 5 seconds).
	for i := 0; i < 50; i++ {
		if _, err := os.Stat(socketPath()); err == nil {
			pid := readPid()
			fmt.Printf("Daemon started (pid %d)\n", pid)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Fprintf(os.Stderr, "Daemon started but socket not yet available\n")
}

func cmdStop() {
	pid := readPid()
	if pid == 0 || !processAlive(pid) {
		fmt.Println("Daemon not running")
		os.Remove(pidPath())
		os.Remove(socketPath())
		return
	}
	// Send SIGTERM for graceful shutdown.
	syscall.Kill(pid, syscall.SIGTERM)
	// Wait up to 5 seconds for the process to exit.
	for i := 0; i < 50; i++ {
		if !processAlive(pid) {
			fmt.Printf("Daemon stopped (was pid %d)\n", pid)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Fprintf(os.Stderr, "Daemon did not stop within 5s, sending SIGKILL\n")
	syscall.Kill(pid, syscall.SIGKILL)
	time.Sleep(200 * time.Millisecond)
	os.Remove(pidPath())
	os.Remove(socketPath())
}

func cmdStatus() {
	pid := readPid()
	if pid == 0 || !processAlive(pid) {
		fmt.Println("Daemon is not running")
		os.Exit(1)
	}
	fmt.Printf("Daemon is running (pid %d)\n", pid)
}

func readPid() int {
	data, err := os.ReadFile(pidPath())
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		return 0
	}
	return pid
}

func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
