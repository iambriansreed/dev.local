import Foundation

// What crosses the server's Unix socket, as bytes: an HTTP response, and the WebSocket frames
// of the live push. URLSession speaks neither over a socket file, so the app does it itself
// (DevLocal/UnixSocket.swift); the parsing lives here, where it can be tested.

/// The status and body of a whole HTTP response, or nil while the headers are incomplete.
/// The app sends HTTP/1.0, which Node answers with the body as is and then closes, so the
/// body is everything after the headers; a chunked one is joined in case.
public func parseHTTPResponse(_ raw: Data) -> (status: Int, body: Data)? {
    guard let end = raw.firstRange(of: Data("\r\n\r\n".utf8)) else { return nil }
    let head = String(decoding: raw[raw.startIndex..<end.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2, let status = Int(parts[1]) else { return nil }
    let body = Data(raw[end.upperBound...])
    let chunked = lines.dropFirst().contains {
        $0.lowercased().hasPrefix("transfer-encoding:") && $0.lowercased().contains("chunked")
    }
    return (status, chunked ? unchunk(body) : body)
}

private func unchunk(_ body: Data) -> Data {
    var out = Data()
    var rest = body[...]
    while let lineEnd = rest.firstRange(of: Data("\r\n".utf8)) {
        let sizeText = String(decoding: rest[rest.startIndex..<lineEnd.lowerBound], as: UTF8.self)
        guard let size = Int(sizeText.split(separator: ";").first ?? "", radix: 16), size > 0 else { break }
        let start = lineEnd.upperBound
        guard rest.distance(from: start, to: rest.endIndex) >= size else { break }
        let stop = rest.index(start, offsetBy: size)
        out += rest[start..<stop]
        rest = rest[stop...].dropFirst(2)
    }
    return out
}

/// A client's text frame. Masked, as RFC 6455 requires of a client and the server checks.
public func webSocketTextFrame(_ text: String, mask: [UInt8]) -> Data {
    let payload = Array(text.utf8)
    var frame = Data([0x81])
    if payload.count < 126 {
        frame.append(0x80 | UInt8(payload.count))
    } else if payload.count < 65536 {
        frame.append(contentsOf: [0x80 | 126, UInt8(payload.count >> 8), UInt8(payload.count & 0xff)])
    } else {
        frame.append(0x80 | 127)
        for shift in stride(from: 56, through: 0, by: -8) { frame.append(UInt8((payload.count >> shift) & 0xff)) }
    }
    frame.append(contentsOf: mask)
    frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
    return frame
}

/// One server frame off the front of `buffer`, and how many bytes it took; nil while the
/// rest of it is still on its way. The server never masks, so a mask is skipped, not applied.
public func readWebSocketFrame(_ buffer: Data) -> (opcode: UInt8, payload: Data, size: Int)? {
    let bytes = [UInt8](buffer.prefix(14))
    guard bytes.count >= 2 else { return nil }
    let masked = bytes[1] & 0x80 != 0
    var length = Int(bytes[1] & 0x7f)
    var offset = 2
    if length == 126 {
        guard bytes.count >= 4 else { return nil }
        length = Int(bytes[2]) << 8 | Int(bytes[3])
        offset = 4
    } else if length == 127 {
        guard bytes.count >= 10 else { return nil }
        length = bytes[2..<10].reduce(0) { $0 << 8 | Int($1) }
        offset = 10
    }
    if masked { offset += 4 }
    guard buffer.count >= offset + length else { return nil }
    let start = buffer.index(buffer.startIndex, offsetBy: offset)
    return (bytes[0] & 0x0f, Data(buffer[start..<buffer.index(start, offsetBy: length)]), offset + length)
}

/// Whether the reply to the WebSocket upgrade request switched protocols.
public func upgradeAccepted(_ head: String) -> Bool {
    head.hasPrefix("HTTP/1.1 101")
}
