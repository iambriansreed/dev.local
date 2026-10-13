import Darwin
import DevLocalCore
import Foundation

/// The server's API is a Unix socket file (~/.dev.localhost/server.sock, mode 0600), not a
/// port: nothing but the user's own processes can reach it, where a page in any browser can
/// send requests to 127.0.0.1. URLSession cannot connect to a socket file, so this is the
/// little it takes by hand: a blocking POSIX socket, used off the main thread.
final class UnixSocket: @unchecked Sendable {
    enum Failure: Error {
        case pathTooLong
        case system(String, Int32)
    }

    private let fd: Int32
    private let lock = NSLock()
    private var closed = false

    /// Connect to the socket at `path`. `timeout` bounds every read and write after this.
    init(path: String, timeout: TimeInterval) throws {
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure.system("socket", errno) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            Darwin.close(fd)
            throw Failure.pathTooLong
        }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: bytes)
            buffer[bytes.count] = 0
        }
        var interval = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            let code = errno
            Darwin.close(fd)
            throw Failure.system("connect", code)
        }
    }

    deinit { close() }

    func write(_ data: Data) throws {
        try data.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            var sent = 0
            while sent < buffer.count {
                let n = Darwin.write(fd, buffer.baseAddress! + sent, buffer.count - sent)
                guard n > 0 else { throw Failure.system("write", errno) }
                sent += n
            }
        }
    }

    /// The next bytes, or nil when the other end has closed.
    func read() throws -> Data? {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = Darwin.read(fd, &buffer, buffer.count)
        if n == 0 { return nil }
        guard n > 0 else { throw Failure.system("read", errno) }
        return Data(buffer[0..<n])
    }

    /// Safe to call twice and from another thread: a read blocked on this socket returns.
    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        Darwin.shutdown(fd, SHUT_RDWR)
        Darwin.close(fd)
    }
}

/// One HTTP request over the socket. HTTP/1.0, so the server sends the body as is and closes
/// when it is done: the response is everything read until then.
enum UnixHTTP {
    struct BadResponse: Error {}

    static func request(
        socket path: String, method: String, path route: String, body: Data? = nil, timeout: TimeInterval = 120
    ) async throws -> (status: Int, body: Data) {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let socket = try UnixSocket(path: path, timeout: timeout)
                    var head = "\(method) \(route) HTTP/1.0\r\nHost: localhost\r\n"
                    if let body {
                        head += "Content-Type: application/json\r\nContent-Length: \(body.count)\r\n"
                    } else if method != "GET" {
                        head += "Content-Length: 0\r\n"
                    }
                    try socket.write(Data((head + "\r\n").utf8) + (body ?? Data()))
                    var raw = Data()
                    while let chunk = try socket.read() { raw += chunk }
                    socket.close()
                    guard let response = parseHTTPResponse(raw) else { throw BadResponse() }
                    continuation.resume(returning: response)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

/// The live push at /ws, over the socket: the upgrade by hand, then a thread that reads
/// frames until the connection drops. Text payloads go to `onText` on the main actor, and
/// `onClose` fires once, however it ended.
final class UnixWebSocket: @unchecked Sendable {
    private let socket: UnixSocket
    private let writes = DispatchQueue(label: "dev.localhost.websocket.write")

    private init(socket: UnixSocket) {
        self.socket = socket
    }

    /// Connect and upgrade. Throws if the socket isn't there or the server refuses.
    static func open(
        socket path: String, onText: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void
    ) async throws -> UnixWebSocket {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                do {
                    // Reads block for as long as the server is quiet; it pushes every 2s
                    let socket = try UnixSocket(path: path, timeout: 30)
                    let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
                    let request = "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                        + "Connection: Upgrade\r\nSec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"
                    try socket.write(Data(request.utf8))
                    var buffer = Data()
                    var headEnd: Range<Data.Index>?
                    while headEnd == nil {
                        guard let chunk = try socket.read() else { throw UnixHTTP.BadResponse() }
                        buffer += chunk
                        headEnd = buffer.firstRange(of: Data("\r\n\r\n".utf8))
                    }
                    let head = String(decoding: buffer[buffer.startIndex..<headEnd!.lowerBound], as: UTF8.self)
                    guard upgradeAccepted(head) else { throw UnixHTTP.BadResponse() }
                    let connection = UnixWebSocket(socket: socket)
                    connection.readLoop(leftover: Data(buffer[headEnd!.upperBound...]), onText: onText, onClose: onClose)
                    continuation.resume(returning: connection)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func send(_ text: String) {
        let frame = webSocketTextFrame(text, mask: (0..<4).map { _ in UInt8.random(in: 0...255) })
        writes.async { [socket] in try? socket.write(frame) }
    }

    func close() {
        socket.close()
    }

    private func readLoop(
        leftover: Data, onText: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void
    ) {
        Thread.detachNewThread { [socket] in
            var buffer = leftover
            defer { Task { @MainActor in onClose() } }
            while true {
                while let frame = readWebSocketFrame(buffer) {
                    buffer = Data(buffer.dropFirst(frame.size))
                    switch frame.opcode {
                    case 0x1:
                        let text = String(decoding: frame.payload, as: UTF8.self)
                        Task { @MainActor in onText(text) }
                    case 0x8:
                        socket.close()
                        return
                    default:
                        continue
                    }
                }
                guard let chunk = try? socket.read() else {
                    socket.close()
                    return
                }
                buffer += chunk
            }
        }
    }
}
