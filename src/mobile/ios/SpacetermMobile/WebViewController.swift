import UIKit
import WebKit

/// The web view, configured for an app that is a web page and nothing else.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private var webView: WKWebView!
    /// Times iOS has ended the page's process since launch; see below.
    private var processRestarts = 0

    /// `SpacetermURL` from Info.plist, written at build time by install.sh.
    private let startURL: URL? = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "SpacetermURL") as? String,
              !raw.isEmpty else { return nil }
        return URL(string: raw)
    }()

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Persistent storage: the pairing token, drafts and the open surface
        // survive relaunches, as they would in a browser.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Lets the page tell it is running inside the app, should it need to.
        config.applicationNameForUserAgent = "SpacetermApp/1"

        // Which build of this app is running, for the page to compare with the
        // newest source (native-version.mjs) and ask for an update when behind.
        if let version = Bundle.main.object(forInfoDictionaryKey: "SpacetermNativeVersion") as? String,
           !version.isEmpty {
            config.userContentController.addUserScript(WKUserScript(
                source: "window.spacetermNativeVersion = '\(version)'",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // The screen's corner radius, which a page cannot read: the canvas's
        // corner buttons sit as low and as far out as the curve allows.
        if let radius = Self.displayCornerRadius {
            config.userContentController.addUserScript(WKUserScript(
                source: "document.documentElement.style.setProperty('--m-corner-radius', '\(radius)px')",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x11 / 255, green: 0x11 / 255, blue: 0x1b / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        // The page lays itself out against env(safe-area-inset-*) and handles
        // every touch itself; the scroll view must neither inset nor scroll it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        // Safari's Web Inspector can attach over USB/Wi-Fi: this is a personal tool.
        webView.isInspectable = true
        webView.removeFormAccessoryBar()
        view = webView
    }

    /// UIKit knows it but does not publish it; a personal app may ask anyway.
    /// Nil when the key is missing, and the page falls back to its default.
    private static var displayCornerRadius: Double? {
        (UIScreen.main.value(forKey: "_displayCornerRadius") as? NSNumber)?.doubleValue
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load()
    }

    private func load() {
        guard let url = startURL else {
            showProblem("This build has no Spaceterm address. Rebuild it with <code>src/mobile/ios/install.sh</code> on your Mac.")
            return
        }
        webView.load(URLRequest(url: url))
    }

    // MARK: - Microphone

    /// Grant the microphone to Spaceterm's own page without asking each time.
    /// iOS still asks once, for the app, using NSMicrophoneUsageDescription.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == startURL?.host ? .grant : .deny)
    }

    // MARK: - Navigation

    /// Spaceterm's own pages stay here; anything else opens in the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || url.host == startURL?.host {
            decisionHandler(.allow)
        } else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showProblem("Could not reach Spaceterm: \(error.localizedDescription).<br>Is the Mac awake, and Tailscale connected on both?")
    }

    /// iOS kills a page's process when it uses too much memory; without this
    /// the app would sit on a blank screen.
    /// The reloaded page is told how many times, so its log says why it reloaded.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        processRestarts += 1
        webView.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.spacetermProcessRestarts = \(processRestarts)",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        load()
    }

    /// No browser to show an error page, so a minimal one with a way back.
    private func showProblem(_ message: String) {
        let retry = startURL.map { "<p><a href=\"\($0.absoluteString)\" style=\"color:#cba6f7\">Try again</a></p>" } ?? ""
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
        <body style="margin:0;padding:calc(48px + env(safe-area-inset-top)) 24px;background:#11111b;color:#cdd6f4;
          font:17px/1.45 -apple-system,system-ui">
        <h2 style="margin-top:0">Spaceterm</h2><p>\(message)</p>\(retry)
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}
