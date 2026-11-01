import AppIntents

/// The Action button's way to the last "dictate …" (NativeDictation.swift):
/// the first step of the shortcut the Mac makes and signs, which copies it
/// with Shortcuts' own Copy to Clipboard and shows what it copied
/// (src/server/action-button-shortcut.ts). The step is found by this type's
/// name, `GetLastDictationIntent`: renaming it breaks shortcuts already added.
///
/// The app cannot copy it itself: an action that set the clipboard from here,
/// run by the Action button, was refused by iOS as any background write is
/// (November 1 2026), so it is gone.
struct GetLastDictationIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Last Dictation"
    static let description = IntentDescription("The last thing you said after “dictate”, hands-free in Spaceterm. Follow it with Copy to Clipboard.")
    static let openAppWhenRun = false

    func perform() async throws -> some IntentResult & ReturnsValue<String> {
        guard let text = LastDictation.text else { throw NothingDictated() }
        // The press was taken: the app sparkles, so the shortcut need not show anything.
        await MainActor.run { NotificationCenter.default.post(name: LastDictation.handedOut, object: nil) }
        return .result(value: text)
    }
}

struct NothingDictated: Error, CustomLocalizedStringResourceConvertible {
    var localizedStringResource: LocalizedStringResource { "Nothing dictated yet." }
}
