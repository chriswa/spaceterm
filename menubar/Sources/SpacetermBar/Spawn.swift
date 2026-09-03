import Foundation

/// How a supervised process ended.
enum ExitStatus: Equatable {
    case exited(Int32)
    case signaled(Int32)
    /// A process this app did not spawn (adopted after a relaunch of the bar)
    /// cannot be `waitpid`ed, so its status is unknowable.
    case unknown

    var label: String {
        switch self {
        case .exited(let c):   return "exited \(c)"
        case .signaled(let s): return "killed by signal \(s)"
        case .unknown:         return "exited"
        }
    }
}

/// Launches a service in its own session/process group and reports its exit.
///
/// The group is the point. A service is a small tree — `node tsx` forks the
/// real server, `electron-vite` forks Electron, which forks its helpers — and
/// stopping it has to reach every leaf. With `POSIX_SPAWN_SETSID` the leader's
/// pid is also the group id, so `kill(-pid, SIGTERM)` reaches all of them in
/// one call, and nothing else on the machine (the pty-daemon starts its own
/// session, so a group kill never touches it).
///
/// Being in a separate session also means the tree outlives this app: quitting
/// or relaunching the bar leaves Spaceterm running, and the new instance picks
/// the processes back up from `spaceterm-bar.json`.
enum SpawnError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let m) = self { return m }; return nil }
}

enum Spawn {

    struct Launched {
        let pid: pid_t
        let startedAt: Date
    }

    /// Runs `argv` through a login shell (`zsh -l -c 'exec …'`) so it sees the
    /// same PATH a terminal would — Homebrew's node is not on a GUI app's
    /// PATH — and `exec` makes the shell disappear into the command, so the
    /// leader pid is the command itself. stdout and stderr append to `log`.
    static func launch(argv: [String], cwd: String, log: String,
                       viaLoginShell: Bool = true) throws -> Launched {
        // Fail here, with a sentence, rather than let posix_spawn report a bare
        // ENOENT that could mean any of the executable, the cwd or the log.
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir), isDir.boolValue else {
            throw SpawnError.message("working directory does not exist: \(cwd)")
        }
        guard viaLoginShell || FileManager.default.isExecutableFile(atPath: argv[0]) else {
            throw SpawnError.message("not executable: \(argv[0])")
        }

        let words: [String]
        if viaLoginShell {
            let quoted = argv.map(shellQuote).joined(separator: " ")
            words = ["/bin/zsh", "-l", "-c", "exec " + quoted]
        } else {
            words = argv
        }

        rotateIfHuge(log)
        appendBanner(log, "started: " + argv.joined(separator: " "))

        var attr: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT))

        var fa: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&fa)
        defer { posix_spawn_file_actions_destroy(&fa) }
        posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&fa, 1, log, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        posix_spawn_file_actions_adddup2(&fa, 1, 2)
        posix_spawn_file_actions_addchdir_np(&fa, cwd)

        let cArgs = words.map { strdup($0) } + [nil]
        let cEnv = environment().map { strdup($0) } + [nil]
        defer {
            cArgs.forEach { free($0) }
            cEnv.forEach { free($0) }
        }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, words[0], &fa, &attr, cArgs, cEnv)
        guard rc == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(rc),
                          userInfo: [NSLocalizedDescriptionKey: String(cString: strerror(rc))])
        }
        return Launched(pid: pid, startedAt: Date())
    }

    /// Variables an agent CLI stamps on its child processes to mark them as its
    /// own session. They reach us when the bar is started from inside one —
    /// `open SpacetermBar.app` in a Claude Code Bash tool forwards the caller's
    /// environment — and, forwarded on, make every Claude Code session in
    /// Spaceterm believe it is a nested child and stop saving transcripts.
    /// Mirrors `INHERITED_AGENT_SESSION_VARS` in `src/server/spawn-env.ts`,
    /// which applies the same scrub per PTY; keep the two lists identical.
    static let inheritedAgentSessionVars: Set<String> = [
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_BRIDGE_SESSION_ID",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_SSE_PORT",
    ]

    /// `env` without another agent session's identity variables.
    static func scrubInheritedAgentEnv(_ env: [String: String]) -> [String: String] {
        env.filter { !inheritedAgentSessionVars.contains($0.key) }
    }

    /// Our environment, minus any enclosing agent session, with the usual node
    /// locations prepended to PATH as a floor under whatever the login shell adds.
    private static func environment() -> [String] {
        var env = scrubInheritedAgentEnv(ProcessInfo.processInfo.environment)
        let extra = ["/opt/homebrew/bin", "/usr/local/bin"]
        let path = (env["PATH"] ?? "/usr/bin:/bin").split(separator: ":").map(String.init)
        env["PATH"] = (extra + path.filter { !extra.contains($0) }).joined(separator: ":")
        env["SPACETERM_SUPERVISOR"] = "SpacetermBar"
        return env.map { "\($0.key)=\($0.value)" }
    }

    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    // MARK: - Signals

    /// SIGTERM to the whole group. Node handles it as a graceful shutdown;
    /// Electron quits.
    static func terminateGroup(_ pgid: pid_t) { kill(-pgid, SIGTERM) }

    static func killGroup(_ pgid: pid_t) { kill(-pgid, SIGKILL) }

    static func isAlive(_ pid: pid_t) -> Bool {
        // kill(0) succeeds for a live process — including a zombie we have not
        // reaped yet, which is why callers also watch for the exit event.
        kill(pid, 0) == 0 || errno == EPERM
    }

    // MARK: - Log files

    private static func rotateIfHuge(_ path: String) {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        if let size = attrs?[.size] as? UInt64, size > Settings.maxLogBytes {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    private static func appendBanner(_ path: String, _ text: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let line = "\n---- [SpacetermBar \(stamp)] \(text)\n"
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        if let h = FileHandle(forWritingAtPath: path) {
            h.seekToEndOfFile()
            h.write(line.data(using: .utf8) ?? Data())
            try? h.close()
        }
    }
}

/// Watches one pid for exit. For our own children the exit status is reaped
/// with `waitpid`; for adopted processes only the fact of exit is available.
final class ExitWatch {
    private let pid: pid_t
    private let isOwnChild: Bool
    private var source: DispatchSourceProcess?
    private var fired = false

    init(pid: pid_t, isOwnChild: Bool, onExit: @escaping (ExitStatus) -> Void) {
        self.pid = pid
        self.isOwnChild = isOwnChild

        let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        src.setEventHandler { [weak self] in
            guard let self, !self.fired else { return }
            self.fired = true
            onExit(self.reap())
            self.source?.cancel()
        }
        src.resume()
        source = src

        // The process may already be gone by the time the source is armed. For
        // a child that shows up as a reapable zombie; for a stranger, as a
        // failed kill(0). Either way the event would never arrive.
        if isOwnChild {
            var status: Int32 = 0
            if waitpid(pid, &status, WNOHANG) == pid {
                fired = true
                src.cancel()
                DispatchQueue.main.async { onExit(ExitWatch.decode(status)) }
            }
        } else if !Spawn.isAlive(pid) {
            fired = true
            src.cancel()
            DispatchQueue.main.async { onExit(.unknown) }
        }
    }

    deinit { source?.cancel() }

    private func reap() -> ExitStatus {
        guard isOwnChild else { return .unknown }
        var status: Int32 = 0
        guard waitpid(pid, &status, WNOHANG) == pid else { return .unknown }
        return ExitWatch.decode(status)
    }

    private static func decode(_ status: Int32) -> ExitStatus {
        // WIFEXITED / WEXITSTATUS / WTERMSIG are macros and not imported.
        let sig = status & 0x7f
        return sig == 0 ? .exited((status >> 8) & 0xff) : .signaled(sig)
    }
}
