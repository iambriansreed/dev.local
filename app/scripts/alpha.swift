// Makes the white background of a qlmanage render transparent, so the icons can be used
// as they are. Usage: swift alpha.swift <mode> <in.png> <out.png>
//   template: black mark on white becomes black with alpha = darkness (a macOS template image)
//   border:   white reached from the edges becomes transparent; the white glyph inside the tile stays
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let image = NSImage(contentsOfFile: args[2]),
      let tiff = image.tiffRepresentation, let source = NSBitmapImageRep(data: tiff) else {
    FileHandle.standardError.write("usage: alpha.swift template|border <in.png> <out.png>\n".data(using: .utf8)!)
    exit(1)
}
let w = source.pixelsWide, h = source.pixelsHigh
guard let out = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32
) else { exit(1) }

func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
    let c = source.colorAt(x: x, y: y)!.usingColorSpace(.deviceRGB)!
    return (Double(c.redComponent), Double(c.greenComponent), Double(c.blueComponent))
}
func lum(_ x: Int, _ y: Int) -> Double {
    let (r, g, b) = rgb(x, y)
    return 0.299 * r + 0.587 * g + 0.114 * b
}

switch args[1] {
case "template":
    for y in 0..<h { for x in 0..<w {
        let alpha = 1 - lum(x, y)
        out.setColor(NSColor(deviceRed: 0, green: 0, blue: 0, alpha: CGFloat(alpha)), atX: x, y: y)
    } }
case "border":
    // Flood fill from every edge pixel through near-white pixels.
    var outside = [Bool](repeating: false, count: w * h)
    var queue: [(Int, Int)] = []
    func push(_ x: Int, _ y: Int) {
        guard x >= 0, y >= 0, x < w, y < h, !outside[y * w + x], lum(x, y) > 0.96 else { return }
        outside[y * w + x] = true
        queue.append((x, y))
    }
    for x in 0..<w { push(x, 0); push(x, h - 1) }
    for y in 0..<h { push(0, y); push(w - 1, y) }
    var head = 0
    while head < queue.count {
        let (x, y) = queue[head]; head += 1
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
    }
    for y in 0..<h { for x in 0..<w {
        let (r, g, b) = rgb(x, y)
        let alpha: CGFloat = outside[y * w + x] ? 0 : 1
        out.setColor(NSColor(deviceRed: CGFloat(r), green: CGFloat(g), blue: CGFloat(b), alpha: alpha), atX: x, y: y)
    } }
default:
    exit(1)
}

guard let png = out.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[3]))
