import XCTest
@testable import DevLocalCore

// The bytes the app and the server exchange over the Unix socket.
final class WireTests: XCTestCase {
    private func data(_ text: String) -> Data { Data(text.utf8) }

    // Node answers an HTTP/1.0 request with the body as is, ended by closing the socket.
    func testResponseStatusAndBody() {
        let raw = data("HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\nConnection: close\r\n\r\n{\"ok\":false}")
        let response = parseHTTPResponse(raw)
        XCTAssertEqual(response?.status, 400)
        XCTAssertEqual(response.map { String(decoding: $0.body, as: UTF8.self) }, "{\"ok\":false}")
    }

    // In case anything answers chunked after all, the body still comes out whole.
    func testChunkedResponseIsJoined() {
        let raw = data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\n\r\n")
        XCTAssertEqual(parseHTTPResponse(raw).map { String(decoding: $0.body, as: UTF8.self) }, "{\"ok\":true}")
    }

    func testTruncatedResponseIsNil() {
        XCTAssertNil(parseHTTPResponse(data("HTTP/1.1 200 OK\r\ncontent-type: app")))
    }

    // Client frames must be masked (RFC 6455 5.3): the server refuses anything else.
    func testTextFrameIsMaskedWithItsKey() {
        let frame = webSocketTextFrame("{\"watch\":null}", mask: [1, 2, 3, 4])
        XCTAssertEqual(frame[0], 0x81)
        XCTAssertEqual(frame[1], 0x80 | 14)
        XCTAssertEqual(Array(frame[2..<6]), [1, 2, 3, 4])
        let unmasked = frame[6...].enumerated().map { $0.element ^ [1, 2, 3, 4][$0.offset % 4] }
        XCTAssertEqual(String(decoding: unmasked, as: UTF8.self), "{\"watch\":null}")
    }

    func testLongTextFrameUsesTheSixteenBitLength() {
        let frame = webSocketTextFrame(String(repeating: "a", count: 300), mask: [0, 0, 0, 0])
        XCTAssertEqual(frame[1], 0x80 | 126)
        XCTAssertEqual(Int(frame[2]) << 8 | Int(frame[3]), 300)
        XCTAssertEqual(frame.count, 4 + 4 + 300)
    }

    // The server's frames are unmasked, and arrive split or several at once.
    func testServerFramesAreReadOneAtATime() {
        let first = Data([0x81, 5]) + data("hello")
        let second = Data([0x81, 126, 0x01, 0x2C]) + Data(repeating: 0x61, count: 300)
        let buffer = first + second
        let one = readWebSocketFrame(buffer)
        XCTAssertEqual(one?.opcode, 1)
        XCTAssertEqual(one.map { String(decoding: $0.payload, as: UTF8.self) }, "hello")
        XCTAssertEqual(one?.size, 7)
        let two = readWebSocketFrame(buffer.dropFirst(7))
        XCTAssertEqual(two?.payload.count, 300)
        XCTAssertNil(readWebSocketFrame(second.prefix(100)), "a frame not all here yet is nil, not an error")
    }

    func testSixtyFourBitLength() {
        var frame = Data([0x81, 127, 0, 0, 0, 0, 0, 1, 0, 0])
        frame += Data(repeating: 0x62, count: 65536)
        XCTAssertEqual(readWebSocketFrame(frame)?.payload.count, 65536)
    }

    func testUpgradeIsAcceptedOnlyOnA101() {
        XCTAssertTrue(upgradeAccepted("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"))
        XCTAssertFalse(upgradeAccepted("HTTP/1.1 404 Not Found\r\n"))
    }
}
