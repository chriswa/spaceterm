import UIKit
import WebKit

/// A signed shortcut the Mac made, handed to Shortcuts — the Action button's
/// Copy Last Dictation (src/mobile/action-button-setup.ts).
///
///   page → app:  `{id, url, name}`
///   app → page:  `spacetermNativeShortcut.reply(id, {opened: true})` or `{error}`
///
/// Shortcuts' `import-shortcut` link takes only iCloud links: one to the Mac's
/// own copy was refused as invalid before Shortcuts ever fetched it
/// (November 1 2026). A file opened in Shortcuts is not — that is how a
/// shortcut AirDropped or tapped in Files is added. So the app fetches the
/// file and offers it to Shortcuts with iOS's Open In sheet: tap Shortcuts,
/// then Add Shortcut.
@MainActor
final class NativeShortcutImport: NSObject, WKScriptMessageHandler, UIDocumentInteractionControllerDelegate {
    weak var webView: WKWebView?
    /// What the sheet is shown over.
    weak var presenter: UIViewController?
    private let events: NativeEvents
    /// The sheet's controller, held while it is up: iOS does not keep it.
    private var document: UIDocumentInteractionController?

    init(events: NativeEvents) {
        self.events = events
        super.init()
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
            guard let raw = body["url"] as? String, let url = URL(string: raw) else {
                reply(id, ["error": "the shortcut's address is not a URL"])
                return
            }
            let name = (body["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Shortcut"
            Task { await self.fetchAndOffer(id: id, url: url, name: name) }
        }
    }

    private func fetchAndOffer(id: String, url: URL, name: String) async {
        let file: URL
        do {
            let (downloaded, response) = try await URLSession.shared.download(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                throw NSError(domain: "Spaceterm", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "the Mac answered \(http.statusCode)"])
            }
            // Shortcuts names what it imports after the file.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("shortcuts", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            file = dir.appendingPathComponent("\(name).shortcut")
            try? FileManager.default.removeItem(at: file)
            try FileManager.default.moveItem(at: downloaded, to: file)
        } catch {
            events.record("shortcut-import", ["fetched": false, "error": error.localizedDescription])
            reply(id, ["error": "could not fetch the shortcut from the Mac: \(error.localizedDescription)"])
            return
        }
        guard let view = presenter?.view else {
            reply(id, ["error": "the app has nothing to show the sheet over"])
            return
        }
        let controller = UIDocumentInteractionController(url: file)
        controller.uti = "com.apple.shortcut"
        controller.name = name
        controller.delegate = self
        document = controller
        let shown = controller.presentOpenInMenu(from: view.bounds, in: view, animated: true)
        events.record("shortcut-import", ["fetched": true, "sheet": shown])
        if shown {
            reply(id, ["opened": true])
        } else {
            document = nil
            reply(id, ["error": "no app on this iPhone offered to open the shortcut"])
        }
    }

    nonisolated func documentInteractionController(_ controller: UIDocumentInteractionController, willBeginSendingToApplication application: String?) {
        MainActor.assumeIsolated { events.record("shortcut-import-sent", ["to": application ?? "?"]) }
    }

    nonisolated func documentInteractionControllerDidDismissOpenInMenu(_ controller: UIDocumentInteractionController) {
        MainActor.assumeIsolated { if document === controller { document = nil } }
    }

    private func reply(_ id: String, _ answer: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id, answer]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript(
            "(function(a){window.spacetermNativeShortcut && window.spacetermNativeShortcut.reply(a[0], a[1])})(\(json)), 0",
            completionHandler: nil)
    }
}
