import Foundation

enum ServiceState: Equatable {
    /// Not running, and nobody asked it to be.
    case stopped
    /// Spawned; not yet confirmed up.
    case starting(pid_t)
    case running(pid_t)
    /// We sent SIGTERM and are waiting for the exit.
    case stopping(pid_t)
    /// Crashed (or asked for a restart); the respawn is scheduled.
    case restarting(reason: String, at: Date)
    /// Crashed repeatedly; the supervisor has given up until asked again.
    case failed(String)
    /// Running, but started by something else — `npm run dev` in a terminal.
    /// Shown, never touched: two servers would fight over the socket.
    case external(pid_t)

    var pid: pid_t? {
        switch self {
        case .starting(let p), .running(let p), .stopping(let p), .external(let p): return p
        case .stopped, .restarting, .failed: return nil
        }
    }

    var isUp: Bool { if case .running = self { return true }; return false }
    var isExternal: Bool { if case .external = self { return true }; return false }
    var isFailed: Bool { if case .failed = self { return true }; return false }
    var isOurs: Bool {
        switch self {
        case .starting, .running, .stopping: return true
        default: return false
        }
    }
}

/// What a service is and how to recognise it.
struct ServiceSpec {
    let name: String            // "server" | "client" — key in spaceterm-bar.json
    let title: String           // "Server" | "Client"
    let argv: [String]
    let cwd: String
    let logPath: String
    let viaLoginShell: Bool
    /// Does this `ps` command line belong to an instance of this service?
    let matches: (String) -> Bool
    /// Has a spawned instance finished coming up?
    let isUp: (_ pid: pid_t, _ startedAt: Date, _ snapshot: ProcessSnapshot) -> Bool
}

/// Supervises one service: spawn, watch, restart, stop.
///
/// Restart policy, in order:
///  - exit code 75 → relaunch immediately (that is the code asking for it);
///  - exit 0 → stopped, and stays stopped (the client quitting on Cmd-Q is
///    not a crash);
///  - anything else → relaunch with exponential backoff, up to
///    `Settings.maxConsecutiveCrashes` in a row, then `failed`;
///  - an adopted process, whose exit status cannot be known, is treated as a
///    restart request.
@MainActor
final class ServiceSupervisor {

    let spec: ServiceSpec
    private(set) var state: ServiceState = .stopped {
        didSet { if state != oldValue { onChange?() } }
    }
    private(set) var startedAt: Date?
    private(set) var lastExit: ExitStatus?
    var onChange: (() -> Void)?

    private var pgid: pid_t?
    private var watch: ExitWatch?
    private var restartTimer: Timer?
    private var killTimer: Timer?
    private var restartAfterStop = false
    private var crashCount = 0

    init(spec: ServiceSpec) { self.spec = spec }

    // MARK: - Commands

    /// Returns an error message, or nil if the service is now on its way up.
    @discardableResult
    func start() -> String? {
        switch state {
        case .starting, .running:
            return nil
        case .stopping:
            restartAfterStop = true
            return nil
        case .external(let pid):
            return "\(spec.title) is already running outside SpacetermBar (pid \(pid))."
        case .stopped, .failed, .restarting:
            break
        }
        cancelRestart()
        if case .failed = state { crashCount = 0 }
        return spawn()
    }

    func stop() {
        cancelRestart()
        restartAfterStop = false
        guard let pid = state.pid, state.isOurs, let pgid else {
            if case .external = state { return }
            state = .stopped
            return
        }
        state = .stopping(pid)
        Spawn.terminateGroup(pgid)
        killTimer?.invalidate()
        let t = Timer(timeInterval: Settings.stopGrace, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.escalateKill() }
        }
        RunLoop.main.add(t, forMode: .common)
        killTimer = t
    }

    /// Stop, then start again once the exit lands. A crash-restart that is
    /// already pending just becomes an immediate one.
    func restart() {
        switch state {
        case .starting, .running:
            stop()
            restartAfterStop = true
        case .stopping:
            restartAfterStop = true
        case .stopped, .failed, .restarting:
            start()
        case .external:
            break
        }
    }

    /// Pick a process left running by a previous instance of this app.
    func adopt(pid: pid_t, pgid: pid_t, startedAt: Date) {
        guard case .stopped = state else { return }
        self.pgid = pgid
        self.startedAt = startedAt
        state = .starting(pid)
        watch = ExitWatch(pid: pid, isOwnChild: false) { [weak self] status in
            MainActor.assumeIsolated { self?.handleExit(of: pid, status: status) }
        }
    }

    // MARK: - Polling

    func tick(_ snapshot: ProcessSnapshot) {
        switch state {
        case .starting(let pid):
            if let startedAt, spec.isUp(pid, startedAt, snapshot) { state = .running(pid) }
        case .stopped, .failed, .restarting:
            // Someone else's instance? Only worth reporting when we have
            // nothing of our own in flight.
            if let row = snapshot.first(where: spec.matches) {
                cancelRestart()
                state = .external(row.pid)
            }
        case .external(let pid):
            if !snapshot.isAlive(pid) { state = .stopped }
        case .running, .stopping:
            break
        }
    }

    /// Seconds spent in `.starting`, for the "still starting…" hint.
    var startingFor: TimeInterval? {
        guard case .starting = state, let startedAt else { return nil }
        return Date().timeIntervalSince(startedAt)
    }

    // MARK: - Internals

    private func spawn() -> String? {
        do {
            let launched = try Spawn.launch(argv: spec.argv, cwd: spec.cwd,
                                            log: spec.logPath, viaLoginShell: spec.viaLoginShell)
            let pid = launched.pid
            pgid = pid
            startedAt = launched.startedAt
            state = .starting(pid)
            watch = ExitWatch(pid: pid, isOwnChild: true) { [weak self] status in
                MainActor.assumeIsolated { self?.handleExit(of: pid, status: status) }
            }
            return nil
        } catch {
            state = .failed("could not launch: \(error.localizedDescription)")
            return error.localizedDescription
        }
    }

    private func handleExit(of pid: pid_t, status: ExitStatus) {
        guard state.pid == pid else { return }
        lastExit = status
        let wasStopping: Bool = { if case .stopping = state { return true }; return false }()
        let upFor = startedAt.map { Date().timeIntervalSince($0) } ?? 0

        killTimer?.invalidate(); killTimer = nil
        // Belt and braces: anything left in the group after the leader is
        // gone is a straggler (an Electron helper, say) and has no owner.
        if let pgid { Spawn.killGroup(pgid) }
        watch = nil
        pgid = nil
        startedAt = nil

        if wasStopping {
            if restartAfterStop {
                restartAfterStop = false
                scheduleRestart(reason: "restarting", after: 0.2)
            } else {
                state = .stopped
            }
            return
        }

        switch status {
        case .exited(Settings.restartExitCode), .unknown:
            crashCount = 0
            scheduleRestart(reason: "restart requested", after: 0.2)
        case .exited(0):
            crashCount = 0
            state = .stopped
        default:
            if upFor >= Settings.stableAfter { crashCount = 0 }
            crashCount += 1
            if crashCount >= Settings.maxConsecutiveCrashes {
                state = .failed("\(status.label) — crashed \(crashCount) times in a row; see the log")
                crashCount = 0
            } else {
                let delay = min(pow(2.0, Double(crashCount - 1)), Settings.maxCrashBackoff)
                scheduleRestart(reason: status.label, after: delay)
            }
        }
    }

    private func scheduleRestart(reason: String, after delay: TimeInterval) {
        cancelRestart()
        state = .restarting(reason: reason, at: Date().addingTimeInterval(delay))
        let t = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, case .restarting = self.state else { return }
                _ = self.spawn()
            }
        }
        RunLoop.main.add(t, forMode: .common)
        restartTimer = t
    }

    private func cancelRestart() {
        restartTimer?.invalidate(); restartTimer = nil
    }

    private func escalateKill() {
        guard case .stopping = state, let pgid else { return }
        Spawn.killGroup(pgid)
    }

    /// For persisting across a relaunch of the bar.
    var record: SupervisedRecord? {
        guard state.isOurs, let pid = state.pid, let pgid, let startedAt else { return nil }
        return SupervisedRecord(pid: pid, pgid: pgid, startedAt: startedAt.timeIntervalSince1970)
    }
}

struct SupervisedRecord: Codable, Equatable {
    let pid: pid_t
    let pgid: pid_t
    let startedAt: TimeInterval
}
