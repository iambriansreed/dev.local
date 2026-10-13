import XCTest
@testable import DevLocalCore

// The server's replies, decoded as the app decodes them.
final class ModelTests: XCTestCase {
    // An add or edit answers with the proxy as stored plus its host, not the full ProxyState.
    // When that failed to decode, the save was reported as an unreachable server and the
    // /etc/hosts fix that should follow it never opened.
    func testSaveReplyDecodesWithTheStoredProxyAndItsHost() throws {
        let json = """
        {"ok":true,"applied":{"ok":true,"step":"reload","cert":{"method":"mkcert","hosts":["localhost"]},"out":""},
         "proxy":{"name":"marketing.local.dev","port":4180,"path":"/Users/demo/Projects/site","title":"Marketing","custom":true,"host":"marketing.local.dev"},
         "previousHost":"marketing.dev.localhost"}
        """
        let result = try JSONDecoder().decode(ActionResult.self, from: Data(json.utf8))
        XCTAssertTrue(result.succeeded)
        XCTAssertEqual(result.proxy?.host, "marketing.local.dev")
        XCTAssertEqual(result.previousHost, "marketing.dev.localhost")
    }

    func testHostsFixReplyDecodes() throws {
        let json = #"{"ok":true,"changed":true,"script":"/Users/demo/.dev.localhost/hosts.command"}"#
        let result = try JSONDecoder().decode(ActionResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.changed, true)
        XCTAssertEqual(result.script, "/Users/demo/.dev.localhost/hosts.command")
    }
}
