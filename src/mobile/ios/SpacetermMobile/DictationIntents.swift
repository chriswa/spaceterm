import AppIntents

/// The Action button's way to the last "dictate …" (NativeDictation.swift).
///
/// - **Copy Last Dictation** puts it on the clipboard itself, and is offered
///   ready-made (`SpacetermShortcuts`), so the Action button can be set to it
///   with no shortcut built by hand. Whether iOS lets an action run in the
///   background set the clipboard is not known yet: its reply says which
///   happened, so the first press finds out.
/// - **Get Last Dictation** only hands it on, for a shortcut that copies it
///   with Shortcuts' own Copy to Clipboard — which works from the background.

struct CopyLastDictationIntent: AppIntent {
    static let title: LocalizedStringResource = "Copy Last Dictation"
    static let description = IntentDescription("Puts the last thing you said after “dictate”, hands-free in Spaceterm, on the clipboard.")
    static let openAppWhenRun = false

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        guard let text = LastDictation.text else {
            return .result(value: "", dialog: "Nothing dictated yet.")
        }
        guard LastDictation.copy(text) else {
            return .result(value: text, dialog: "iOS would not let Spaceterm copy it from the background. Use Get Last Dictation, then Copy to Clipboard, instead.")
        }
        return .result(value: text, dialog: "Copied.")
    }
}

struct GetLastDictationIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Last Dictation"
    static let description = IntentDescription("The last thing you said after “dictate”, hands-free in Spaceterm. Follow it with Copy to Clipboard.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        guard let text = LastDictation.text else { throw NothingDictated() }
        return .result(value: text)
    }
}

struct NothingDictated: Error, CustomLocalizedStringResourceConvertible {
    var localizedStringResource: LocalizedStringResource { "Nothing dictated yet." }
}

/// Offered without building anything: in the Shortcuts app under Spaceterm,
/// and in Settings → Action Button → Shortcut.
struct SpacetermShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: CopyLastDictationIntent(),
            phrases: ["Copy my last \(.applicationName) dictation"],
            shortTitle: "Copy Last Dictation",
            systemImageName: "doc.on.clipboard"
        )
    }
}
