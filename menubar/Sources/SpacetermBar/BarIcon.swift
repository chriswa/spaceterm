import AppKit

/// A crescent moon for the server and an angle brace for the client.
///
/// Each half is drawn for its own service: the moon is an outline when the
/// server is down and solid when it is up; the brace is a small thin stroke
/// when the client is down and a bold solid brace when it is up. The brace
/// sits clear of the moon's horns so the two never touch.
///
/// Authored in a 20 × 18 design box and scaled to the menu bar. Template
/// image, so it renders correctly on light and dark menu bars.
enum BarIcon {

    private static let design = CGSize(width: 20, height: 18)
    private static let outline: CGFloat = 1.3

    static func image(serverUp: Bool, clientUp: Bool, height: CGFloat = 16) -> NSImage {
        let s = height / design.height
        let size = NSSize(width: design.width * s, height: height)
        let image = NSImage(size: size, flipped: false) { _ in
            let t = NSAffineTransform()
            t.scale(by: s)
            t.concat()
            NSColor.black.set()

            let moon = crescent()
            if serverUp {
                moon.fill()
            } else {
                moon.lineWidth = outline
                moon.stroke()
            }

            if clientUp {
                boldBrace().fill()
            } else {
                thinBrace().stroke()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    // MARK: - Moon

    /// Outer disc radius 7 at (8, 9); the bite is a radius 7.5 disc six units
    /// to the right. That leaves a thick, open crescent whose inner arc is
    /// short enough that the outline still reads as a moon, not two circles.
    private static func crescent() -> NSBezierPath {
        let c1 = CGPoint(x: 8.0, y: 9), r1: CGFloat = 7.0
        let d: CGFloat = 6.0, r2: CGFloat = 7.5
        let c2 = CGPoint(x: c1.x + d, y: 9)
        let a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
        let h = sqrt(r1 * r1 - a * a)
        let outerHorn = atan2(h, a)        // angle at c1 of the top horn
        let innerHorn = atan2(h, a - d)    // angle at c2 of the top horn
        let cg = CGMutablePath()
        cg.addArc(center: c1, radius: r1, startAngle: outerHorn, endAngle: 2 * .pi - outerHorn, clockwise: false)
        cg.addArc(center: c2, radius: r2, startAngle: 2 * .pi - innerHorn, endAngle: innerHorn, clockwise: true)
        cg.closeSubpath()
        return NSBezierPath(cgPath: cg)
    }

    // MARK: - Brace

    private static let phi: CGFloat = 43 * .pi / 180   // arm angle to the axis
    private static let tipX: CGFloat = 18.8            // outer tip of the bold brace
    private static let armLength: CGFloat = 6.0        // centre-line length of each arm
    private static let armWidth: CGFloat = 2.3         // bold brace thickness
    private static let axisY: CGFloat = 9

    /// Centre-line tip and arm end of the bold brace.
    private static var centreTipX: CGFloat { tipX - (armWidth / 2) / sin(phi) }
    private static var armEnd: CGPoint {
        CGPoint(x: centreTipX - cos(phi) * armLength, y: axisY + sin(phi) * armLength)
    }

    /// One six-point polygon, derived analytically so its outline has no
    /// seams: two outer edges meeting at the tip, two inner edges meeting at
    /// the notch, butt-cut arm ends.
    private static func boldBrace() -> NSBezierPath {
        let k = (armWidth / 2) / sin(phi)
        let notchX = centreTipX - k
        let n = CGPoint(x: sin(phi), y: cos(phi))   // outward normal of the top arm
        let e = armEnd
        let half = armWidth / 2
        let p = NSBezierPath()
        p.move(to: CGPoint(x: e.x + n.x * half, y: e.y + n.y * half))
        p.line(to: CGPoint(x: tipX, y: axisY))
        p.line(to: CGPoint(x: e.x + n.x * half, y: 2 * axisY - (e.y + n.y * half)))
        p.line(to: CGPoint(x: e.x - n.x * half, y: 2 * axisY - (e.y - n.y * half)))
        p.line(to: CGPoint(x: notchX, y: axisY))
        p.line(to: CGPoint(x: e.x - n.x * half, y: e.y - n.y * half))
        p.close()
        return p
    }

    /// The bold brace's centre line at half size, scaled about its centre,
    /// stroked a touch heavier than the moon's outline so it survives 16px.
    private static func thinBrace() -> NSBezierPath {
        let scale: CGFloat = 0.5
        let e = armEnd
        let cx = (centreTipX + e.x) / 2
        func sx(_ x: CGFloat) -> CGFloat { cx + (x - cx) * scale }
        let dy = (e.y - axisY) * scale
        let p = NSBezierPath()
        p.move(to: CGPoint(x: sx(e.x), y: axisY + dy))
        p.line(to: CGPoint(x: sx(centreTipX), y: axisY))
        p.line(to: CGPoint(x: sx(e.x), y: axisY - dy))
        p.lineWidth = 1.4
        p.lineJoinStyle = .miter
        p.lineCapStyle = .butt
        return p
    }

    /// `--icons <dir>` support: one PNG per state at the given height.
    static func writePreviews(to dir: URL, height: CGFloat) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, server, client) in [("off", false, false), ("server", true, false), ("both", true, true), ("client", false, true)] {
            let img = image(serverUp: server, clientUp: client, height: height)
            guard let tiff = img.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { continue }
            try? png.write(to: dir.appendingPathComponent("icon-\(name)-\(Int(height)).png"))
        }
    }
}
