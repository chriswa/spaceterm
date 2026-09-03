import Foundation

/// Small synchronous command runner for short-lived queries (ps, zsh -c
/// 'command -v node'). Everything here finishes in milliseconds.
enum Shell {

    @discardableResult
    static func run(_ launchPath: String, _ args: [String]) -> (out: String, status: Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return ("", -1) }
        // Read before waiting: a pipe that fills up deadlocks a process that
        // is waiting for us to drain it.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "", p.terminationStatus)
    }

    /// What `node` resolves to in a login shell — the same resolution the
    /// supervised processes get. Nil means Spaceterm cannot start.
    static func loginShellNode() -> String? {
        let out = run("/bin/zsh", ["-l", "-c", "command -v node"]).out
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return out.isEmpty ? nil : out
    }
}

/// One row of `ps`.
struct ProcessInfoRow: Equatable {
    let pid: pid_t
    let pgid: pid_t
    let command: String
}

/// A single `ps` pass over every process the user can see. Taken once per
/// poll and shared by both services, so detection never mixes two moments.
struct ProcessSnapshot {
    let rows: [ProcessInfoRow]
    let takenAt: Date

    static func capture() -> ProcessSnapshot {
        let out = Shell.run("/bin/ps", ["-axo", "pid=,pgid=,command="]).out
        var rows: [ProcessInfoRow] = []
        for line in out.split(whereSeparator: \.isNewline) {
            // "  123   456 command with spaces"
            let text = String(line)
            let scanner = Scanner(string: text)
            scanner.charactersToBeSkipped = .whitespaces
            guard let pid = scanner.scanInt32(), let pgid = scanner.scanInt32() else { continue }
            let rest = String(text[scanner.currentIndex...]).trimmingCharacters(in: .whitespaces)
            rows.append(ProcessInfoRow(pid: pid, pgid: pgid, command: rest))
        }
        return ProcessSnapshot(rows: rows, takenAt: Date())
    }

    func row(pid: pid_t) -> ProcessInfoRow? { rows.first { $0.pid == pid } }

    func isAlive(_ pid: pid_t) -> Bool { row(pid: pid) != nil }

    func group(_ pgid: pid_t) -> [ProcessInfoRow] { rows.filter { $0.pgid == pgid } }

    func first(where match: (String) -> Bool) -> ProcessInfoRow? {
        rows.first { match($0.command) }
    }
}
