import UIKit
import WebKit

/// The web view, configured for an app that is a web page and nothing else.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private var webView: WKWebView!

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
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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
