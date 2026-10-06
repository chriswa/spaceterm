import CryptoKit
import Security
import UIKit
import WebKit

/// Answers to approval requests — today, opProxy's 1Password reads — signed by
/// a key only this app's native code can use (APPROVAL_FEED.md; the page's
/// side is src/mobile/native-approvals.ts).
///
/// The provider trusts a reply because this key signed it. Anything on the Mac
/// that can change the web bundle can make the page ask for any signature it
/// likes, so the page is never trusted to say what is being approved: an
/// `approve`-role action is signed only after the user drags the slide control
/// in a native panel across, and that panel shows the request's `confirm` line
/// and the chosen options read from the document itself. Deny and other
/// neutral answers are signed at once — the worst a forged one can do is
/// refuse.
///
/// No Face ID: the user's choice. The key is usable without it.
///
/// The page calls `window.webkit.messageHandlers.approvals.postMessage(…)`
/// and awaits the reply:
/// - `{op: "identity"}` → `{keyId, publicKey, fingerprint, name}`
/// - `{op: "arm", item, action, picks}` → the signed reply once the slide
///   completes, or `null` if it is disarmed or replaced by another `arm` first
/// - `{op: "disarm"}` → `null`
/// - `{op: "sign", item, action, picks}` → the signed reply, for any role but `approve`
@MainActor
final class NativeApprovals: NSObject, WKScriptMessageHandlerWithReply {
    /// Where the panel goes: the view above the web view.
    weak var host: UIView?
    private let events: NativeEvents
    private lazy var panel = ApprovalPanel()
    /// The armed request, and the page's promise for it.
    private var armed: (request: ApprovalRequest, reply: (Any?, String?) -> Void)?

    init(events: NativeEvents) {
        self.events = events
        super.init()
    }

    // MARK: - From the page

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                                           replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            let body = message.body as? [String: Any] ?? [:]
            do {
                switch body["op"] as? String {
                case "identity": replyHandler(try identity(), nil)
                case "arm": try arm(ApprovalRequest(body), reply: replyHandler)
                case "disarm":
                    disarm()
                    replyHandler(NSNull(), nil)
                case "sign":
                    let request = try ApprovalRequest(body)
                    guard request.role != "approve" else {
                        throw ApprovalError("“\(request.action)” approves, so it needs the slide: use arm")
                    }
                    let reply = try sign(request)
                    events.record("approval-signed", ["id": request.id, "action": request.action])
                    replyHandler(reply, nil)
                case let op: throw ApprovalError("unknown op \(op ?? "nil")")
                }
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    /// A new page cannot answer the old one's promise; nor should its panel stay up.
    func pageChanged() {
        disarm()
    }

    // MARK: - Arming

    private func arm(_ request: ApprovalRequest, reply: @escaping (Any?, String?) -> Void) throws {
        guard request.role == "approve" else {
            throw ApprovalError("“\(request.action)” does not approve; sign it with sign")
        }
        guard let host else { throw ApprovalError("no view to show the approval in") }
        // Replaced (a picker changed, say): the old promise learns it will not be answered.
        armed?.reply(NSNull(), nil)
        armed = (request, reply)
        events.record("approval-armed", ["id": request.id, "revision": request.revision, "action": request.action])
        panel.onSlid = { [weak self] in self?.slid() }
        panel.show(request, in: host)
    }

    private func disarm() {
        guard let armed else {
            panel.hide()
            return
        }
        self.armed = nil
        armed.reply(NSNull(), nil)
        events.record("approval-disarmed", ["id": armed.request.id])
        panel.hide()
    }

    /// The user dragged it all the way across: this is the approval.
    private func slid() {
        guard let armed else { return }
        self.armed = nil
        do {
            let reply = try sign(armed.request)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            events.record("approval-slid", ["id": armed.request.id, "action": armed.request.action])
            panel.showSent()
            armed.reply(reply, nil)
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            events.record("approval-sign-failed", ["id": armed.request.id, "error": error.localizedDescription])
            panel.showFailed()
            armed.reply(nil, error.localizedDescription)
        }
    }

    // MARK: - Signing

    private func identity() throws -> [String: Any] {
        let key = try ApprovalKey.shared()
        return [
            "keyId": key.keyId,
            "publicKey": key.publicKey.base64EncodedString(),
            "fingerprint": key.fingerprint,
            "name": UIDevice.current.name,
        ]
    }

    /// The statement APPROVAL_FEED.md specifies, and its signature over
    /// exactly the bytes returned: nobody needs to reproduce the encoding.
    private func sign(_ request: ApprovalRequest) throws -> [String: Any] {
        let key = try ApprovalKey.shared()
        let statement: [String: Any] = [
            "v": 1,
            "provider": request.provider,
            "id": request.id,
            "revision": request.revision,
            "challenge": request.challenge,
            "documentSha256": SHA256.hash(data: Data(request.document.utf8)).hex,
            "action": request.action,
            "picks": request.picks,
            "keyId": key.keyId,
            "signedAt": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let data = try JSONSerialization.data(withJSONObject: statement, options: [.sortedKeys, .withoutEscapingSlashes])
        guard let text = String(data: data, encoding: .utf8) else { throw ApprovalError("the statement is not UTF-8") }
        return [
            "statement": text,
            "signature": try key.sign(data).base64EncodedString(),
            "keyId": key.keyId,
        ]
    }
}

// MARK: - The request

/// What the page asked to have signed, checked against the document it came
/// with. Everything the panel shows comes from here — from the document, not
/// from text the page supplies.
private struct ApprovalRequest {
    let provider: String
    let id: String
    let revision: Int
    let challenge: String
    /// Verbatim, as the provider sent it: its hash goes in the statement.
    let document: String
    let action: String
    let picks: [String: String]

    let role: String
    let actionLabel: String
    let tone: String
    let confirm: String
    /// "Allow: 7 Days", one per pick, in the document's picker order.
    let summary: [String]

    init(_ body: [String: Any]) throws {
        guard let item = body["item"] as? [String: Any] else { throw ApprovalError("no item") }
        guard let provider = item["provider"] as? String, let id = item["id"] as? String,
              let revision = item["revision"] as? Int, let challenge = item["challenge"] as? String,
              let document = item["document"] as? String else {
            throw ApprovalError("the item needs provider, id, revision, challenge and document")
        }
        guard let action = body["action"] as? String else { throw ApprovalError("no action") }
        let picks: [String: String]
        switch body["picks"] {
        case nil, is NSNull: picks = [:]
        case let given as [String: String]: picks = given
        default: throw ApprovalError("picks must map picker ids to option ids")
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(document.utf8)) as? [String: Any] else {
            throw ApprovalError("the document is not a JSON object")
        }
        let actions = parsed["actions"] as? [[String: Any]] ?? []
        guard let chosen = actions.first(where: { $0["id"] as? String == action }) else {
            throw ApprovalError("the document offers no action “\(action)”")
        }
        let pickers = parsed["pickers"] as? [[String: Any]] ?? []
        for (pickerId, optionId) in picks {
            guard let picker = pickers.first(where: { $0["id"] as? String == pickerId }) else {
                throw ApprovalError("the document has no picker “\(pickerId)”")
            }
            let options = picker["options"] as? [[String: Any]] ?? []
            guard options.contains(where: { $0["id"] as? String == optionId }) else {
                throw ApprovalError("picker “\(pickerId)” has no option “\(optionId)”")
            }
        }

        self.provider = provider
        self.id = id
        self.revision = revision
        self.challenge = challenge
        self.document = document
        self.action = action
        self.picks = picks
        role = chosen["role"] as? String ?? ""
        actionLabel = chosen["label"] as? String ?? action
        tone = parsed["tone"] as? String ?? "info"
        confirm = parsed["confirm"] as? String ?? parsed["title"] as? String ?? ""
        // Only what is signed: a picker left out of `picks` is not shown at its default.
        summary = pickers.compactMap { picker in
            guard let pickerId = picker["id"] as? String, let optionId = picks[pickerId] else { return nil }
            let options = picker["options"] as? [[String: Any]] ?? []
            let option = options.first { $0["id"] as? String == optionId }
            let label = picker["label"] as? String ?? pickerId
            return "\(label): \(option?["label"] as? String ?? optionId)"
        }
    }
}

private struct ApprovalError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

private extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

// MARK: - The key

/// The app's signing key: in the Secure Enclave, usable without Face ID, never
/// leaving this phone. The Keychain holds only the Enclave's wrapped handle to
/// it (`dataRepresentation`), which is useless anywhere else.
///
/// The simulator has no Enclave, so there it is an ordinary key kept the same
/// way — for development only, and a provider has to pair it like any other.
private struct ApprovalKey {
    private enum Backing {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }
    private let backing: Backing

    /// Raw X‖Y, 64 bytes.
    let publicKey: Data
    /// Lowercase hex of the first 16 bytes of SHA-256(publicKey).
    let keyId: String
    /// keyId's first 16 hex digits in groups of four: what people compare.
    let fingerprint: String

    private init(_ backing: Backing) {
        self.backing = backing
        switch backing {
        case .enclave(let key): publicKey = key.publicKey.rawRepresentation
        case .software(let key): publicKey = key.publicKey.rawRepresentation
        }
        let id = String(SHA256.hash(data: publicKey).hex.prefix(32))
        keyId = id
        fingerprint = stride(from: 0, to: 16, by: 4).map { offset in
            let start = id.index(id.startIndex, offsetBy: offset)
            return String(id[start..<id.index(start, offsetBy: 4)])
        }.joined(separator: " ")
    }

    /// DER-encoded ECDSA P-256 over SHA-256 of `data`.
    func sign(_ data: Data) throws -> Data {
        switch backing {
        case .enclave(let key): try key.signature(for: data).derRepresentation
        case .software(let key): try key.signature(for: data).derRepresentation
        }
    }

    private static let service = "com.chriswaddell.spaceterm.approval-key"
    private static var account: String { SecureEnclave.isAvailable ? "secure-enclave" : "software" }
    @MainActor private static var cached: ApprovalKey?

    /// The key, made on first use.
    @MainActor static func shared() throws -> ApprovalKey {
        if let cached { return cached }
        let key: ApprovalKey
        if let stored = try read() {
            do {
                key = try restore(stored)
            } catch {
                // A handle the Enclave no longer recognises (a restored backup
                // cannot carry it, but be sure): the old key is gone either way.
                NSLog("[approvals] stored key unusable (%@); making a new one", error.localizedDescription)
                try delete()
                key = try create()
            }
        } else {
            key = try create()
        }
        cached = key
        return key
    }

    private static func restore(_ data: Data) throws -> ApprovalKey {
        SecureEnclave.isAvailable
            ? ApprovalKey(.enclave(try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)))
            : ApprovalKey(.software(try P256.Signing.PrivateKey(rawRepresentation: data)))
    }

    private static func create() throws -> ApprovalKey {
        let key: ApprovalKey
        let data: Data
        if SecureEnclave.isAvailable {
            var error: Unmanaged<CFError>?
            // `.privateKeyUsage` alone: signing needs no Face ID or passcode.
            guard let access = SecAccessControlCreateWithFlags(
                nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error) else {
                throw error?.takeRetainedValue() as Error? ?? ApprovalError("could not make the key's access control")
            }
            let enclave = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
            key = ApprovalKey(.enclave(enclave))
            data = enclave.dataRepresentation
        } else {
            let software = P256.Signing.PrivateKey()
            key = ApprovalKey(.software(software))
            data = software.rawRepresentation
        }
        try write(data)
        NSLog("[approvals] made a new %@ key %@", account, key.fingerprint)
        return key
    }

    // MARK: Keychain

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func read() throws -> Data? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw keychainError("read", status) }
        return result as? Data
    }

    private static func write(_ data: Data) throws {
        var q = query()
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw keychainError("save", status) }
    }

    private static func delete() throws {
        let status = SecItemDelete(query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw keychainError("delete", status) }
    }

    private static func keychainError(_ verb: String, _ status: OSStatus) -> ApprovalError {
        let reason = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return ApprovalError("could not \(verb) the approval key: \(reason)")
    }
}

// MARK: - The panel

/// Docked at the bottom over the web view while a request is armed: what the
/// approval grants, and the slide that grants it.
@MainActor
private final class ApprovalPanel: UIView {
    /// The content's height above the home indicator. The page leaves exactly
    /// this much room, plus the safe area, at its bottom while armed:
    /// `calc(112px + env(safe-area-inset-bottom))` in src/mobile/native-approvals.ts.
    /// Change both together.
    static let contentHeight: CGFloat = 112

    var onSlid: (() -> Void)?

    private let confirmLabel = UILabel()
    private let summaryLabel = UILabel()
    private let slider = SlideToConfirm()
    private var bottomConstraint: NSLayoutConstraint?

    init() {
        super.init(frame: .zero)
        backgroundColor = Palette.mantle
        translatesAutoresizingMaskIntoConstraints = false

        let border = UIView()
        border.backgroundColor = Palette.surface0
        confirmLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        confirmLabel.textColor = Palette.text
        confirmLabel.numberOfLines = 2
        confirmLabel.lineBreakMode = .byTruncatingTail
        summaryLabel.font = .systemFont(ofSize: 13)
        summaryLabel.textColor = Palette.subtext0
        summaryLabel.numberOfLines = 1
        summaryLabel.lineBreakMode = .byTruncatingTail
        slider.onComplete = { [weak self] in self?.onSlid?() }

        let content = UILayoutGuide()
        addLayoutGuide(content)
        for view in [border, confirmLabel, summaryLabel, slider] {
            view.translatesAutoresizingMaskIntoConstraints = false
            addSubview(view)
        }
        // The track sits on the content's bottom edge and the text stacks up
        // from it, so a one-line request leaves its space at the top. Two lines
        // of `confirm`, the summary and the track fill the 112 exactly.
        NSLayoutConstraint.activate([
            border.topAnchor.constraint(equalTo: topAnchor),
            border.leadingAnchor.constraint(equalTo: leadingAnchor),
            border.trailingAnchor.constraint(equalTo: trailingAnchor),
            border.heightAnchor.constraint(equalToConstant: 1),

            content.topAnchor.constraint(equalTo: topAnchor),
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
            content.heightAnchor.constraint(equalToConstant: Self.contentHeight),

            slider.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            slider.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            slider.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            slider.heightAnchor.constraint(equalToConstant: 44),

            summaryLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            summaryLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            summaryLabel.bottomAnchor.constraint(equalTo: slider.topAnchor, constant: -6),

            confirmLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            confirmLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            confirmLabel.bottomAnchor.constraint(equalTo: summaryLabel.topAnchor, constant: -2),
            confirmLabel.topAnchor.constraint(greaterThanOrEqualTo: content.topAnchor, constant: 8),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Up from the bottom the first time; in place when the request changes.
    func show(_ request: ApprovalRequest, in host: UIView) {
        confirmLabel.text = request.confirm
        summaryLabel.text = request.summary.joined(separator: " · ")
        slider.configure(action: request.actionLabel.lowercased(), tone: Palette.tone(request.tone),
                         accessibilityLabel: request.confirm)

        guard superview !== host else {
            layer.removeAllAnimations()
            transform = .identity
            return
        }
        removeFromSuperview()
        host.addSubview(self)
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: host.leadingAnchor),
            trailingAnchor.constraint(equalTo: host.trailingAnchor),
            bottomAnchor.constraint(equalTo: host.bottomAnchor),
            // The content sits above the home indicator; the background runs on under it.
            topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -Self.contentHeight),
        ])
        host.layoutIfNeeded()
        transform = CGAffineTransform(translationX: 0, y: bounds.height)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            self.transform = .identity
        }
    }

    func hide() {
        guard superview != nil else { return }
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
            self.transform = CGAffineTransform(translationX: 0, y: self.bounds.height)
        } completion: { finished in
            // A `show` in between cancelled this; it keeps the panel.
            guard finished else { return }
            self.removeFromSuperview()
            self.transform = .identity
        }
    }

    func showSent() { slider.showSent() }
    func showFailed() { slider.showFailed() }
}

// MARK: - The slide

/// Drag the thumb from left to right and let go at the far end; let go any
/// sooner and it springs back. A tap does nothing, and nothing does anything in
/// the first half second after the request appears or changes — opProxy's own
/// click guard, so the tap that opened the request cannot land on it.
@MainActor
private final class SlideToConfirm: UIView {
    var onComplete: (() -> Void)?

    private enum State { case idle, sent, failed }
    private var state = State.idle
    private var tone = Palette.blue
    private var readyAt = Date.distantFuture
    /// This drag started inside the guard, so the whole of it is ignored.
    private var ignoringDrag = false
    private var dragStart: CGFloat = 0
    /// How far the thumb has come, in points from its start.
    private var offset: CGFloat = 0

    private let fill = UIView()
    private let label = UILabel()
    private let thumb = UIView()
    private let glyph = UIImageView()

    private static let inset: CGFloat = 4
    private static let guardSeconds: TimeInterval = 0.5
    /// How much of the way counts as all of it.
    private static let completeFraction: CGFloat = 0.95

    init() {
        super.init(frame: .zero)
        backgroundColor = Palette.track
        clipsToBounds = true
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.textColor = Palette.subtext0
        label.textAlignment = .center
        glyph.contentMode = .center
        glyph.tintColor = Palette.crust
        for view in [fill, label, thumb] { addSubview(view) }
        thumb.addSubview(glyph)
        addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
        isAccessibilityElement = true
        accessibilityTraits = [.button]
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func configure(action: String, tone: UIColor, accessibilityLabel: String) {
        self.tone = tone
        state = .idle
        offset = 0
        // A drag already under way was aimed at the request this replaces.
        ignoringDrag = true
        readyAt = Date().addingTimeInterval(Self.guardSeconds)
        label.text = "Slide to \(action)"
        label.textColor = Palette.subtext0
        thumb.backgroundColor = tone
        fill.backgroundColor = tone.withAlphaComponent(0.3)
        glyph.image = UIImage(systemName: "chevron.right.2", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .bold))
        self.accessibilityLabel = accessibilityLabel
        accessibilityHint = "Double-tap to \(action)."
        accessibilityValue = nil
        setNeedsLayout()
    }

    func showSent() {
        state = .sent
        offset = travel
        label.text = "Sent"
        label.textColor = tone
        glyph.image = UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .bold))
        accessibilityHint = nil
        accessibilityValue = "Sent"
        setNeedsLayout()
    }

    func showFailed() {
        state = .failed
        offset = 0
        label.text = "Could not sign"
        label.textColor = Palette.red
        glyph.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .bold))
        setNeedsLayout()
    }

    private var thumbSize: CGFloat { bounds.height - 2 * Self.inset }
    private var travel: CGFloat { max(0, bounds.width - 2 * Self.inset - thumbSize) }
    private var ready: Bool { state == .idle && Date() >= readyAt }

    override func layoutSubviews() {
        super.layoutSubviews()
        layer.cornerRadius = bounds.height / 2
        let size = thumbSize
        thumb.frame = CGRect(x: Self.inset + offset, y: Self.inset, width: size, height: size)
        thumb.layer.cornerRadius = size / 2
        glyph.frame = thumb.bounds
        fill.frame = CGRect(x: 0, y: 0, width: thumb.frame.maxX + Self.inset, height: bounds.height)
        label.frame = bounds
        // The label fades as the thumb covers it, except to say how it ended.
        label.alpha = state == .idle ? max(0, 1 - 1.6 * offset / max(travel, 1)) : 1
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            ignoringDrag = !ready
            dragStart = offset
        case .changed:
            guard !ignoringDrag, state == .idle else { return }
            offset = min(max(0, dragStart + gesture.translation(in: self).x), travel)
            setNeedsLayout()
            layoutIfNeeded()
        case .ended, .cancelled, .failed:
            guard !ignoringDrag, state == .idle else { return }
            if gesture.state == .ended, travel > 0, offset >= Self.completeFraction * travel {
                complete()
            } else {
                springBack()
            }
        default: break
        }
    }

    private func complete() {
        offset = travel
        UIView.animate(withDuration: 0.12) { self.setNeedsLayout(); self.layoutIfNeeded() }
        // Whoever owns the request decides what it has become: sent, or not.
        onComplete?()
    }

    private func springBack() {
        offset = 0
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0.4,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.setNeedsLayout()
            self.layoutIfNeeded()
        }
    }

    /// VoiceOver cannot drag: its double-tap is the deliberate act here.
    override func accessibilityActivate() -> Bool {
        guard ready else { return false }
        complete()
        return true
    }
}

/// Catppuccin Mocha, as the page uses it.
private enum Palette {
    static let crust = rgb(0x11111b)
    static let mantle = rgb(0x181825)
    static let track = rgb(0x232336)
    static let surface0 = rgb(0x313244)
    static let subtext0 = rgb(0xa6adc8)
    static let text = rgb(0xcdd6f4)
    static let yellow = rgb(0xf9e2af)
    static let red = rgb(0xf38ba8)
    static let blue = rgb(0x89b4fa)

    static func tone(_ name: String) -> UIColor {
        switch name {
        case "caution": yellow
        case "danger": red
        default: blue
        }
    }

    private static func rgb(_ hex: Int) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}
