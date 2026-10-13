import XCTest
@testable import DevLocalCore

// The add and edit form's rules.
final class AppFormTests: XCTestCase {
    func testBareNameGetsLocalhost() {
        XCTAssertEqual(normalizeHost("myapp"), "myapp.localhost")
        XCTAssertEqual(normalizeHost("  MyApp "), "myapp.localhost")
    }

    func testDottedNameIsKept() {
        XCTAssertEqual(normalizeHost("storybook.ui"), "storybook.ui")
        XCTAssertEqual(normalizeHost("myapp.test"), "myapp.test")
    }

    // A pasted URL means the domain inside it.
    func testPastedURLIsReadAsItsDomain() {
        XCTAssertEqual(normalizeHost("https://myapp.test/path?x=1"), "myapp.test")
        XCTAssertEqual(normalizeHost("http://myapp.localhost."), "myapp.localhost")
    }

    func testNameFromHostStripsLocalhost() {
        XCTAssertEqual(nameFromHost("myapp.localhost"), "myapp")
        XCTAssertEqual(nameFromHost("myapp.test"), "myapp.test")
    }

    func testValidHost() {
        XCTAssertTrue(validHost("myapp.localhost"))
        XCTAssertTrue(validHost("local.api.example.com"))
        XCTAssertFalse(validHost("myapp"))
        XCTAssertFalse(validHost("-bad.localhost"))
        XCTAssertFalse(validHost("my app.localhost"))
        XCTAssertFalse(validHost(""))
    }

    // .local belongs to Bonjour: every visit can stall on an mDNS timeout before /etc/hosts answers.
    func testDotLocalWarnsAsAProblem() {
        let warning = domainWarning(normalizeHost("marketing.dev.local"))
        XCTAssertEqual(warning?.severity, .problem)
        XCTAssertTrue(warning?.text.contains("Bonjour") == true)
        XCTAssertTrue(warning?.text.contains("local.iambrian.com") == true)
    }

    // .localhost works with no setup, so it is only a note: Google and Apple won't redirect to it.
    func testDotLocalhostIsANoteAboutCallbacks() {
        let warning = domainWarning(normalizeHost("myapp"))
        XCTAssertEqual(warning?.severity, .note)
        XCTAssertTrue(warning?.text.contains("Google") == true)
        XCTAssertTrue(warning?.text.contains("Apple") == true)
        XCTAssertTrue(warning?.text.contains("local.iambrian.com") == true)
    }

    func testOtherDomainsHaveNoWarning() {
        XCTAssertNil(domainWarning("local.iambrian.com"))
        XCTAssertNil(domainWarning("myapp.test"))
        // Only the last label counts: local.example.com is not a .local domain.
        XCTAssertNil(domainWarning("local.example.com"))
        XCTAssertNil(domainWarning(""))
    }

    func testValidPort() {
        XCTAssertTrue(validPort(3000))
        XCTAssertFalse(validPort(0))
        XCTAssertFalse(validPort(70000))
        XCTAssertFalse(validPort(nil))
    }

    func testPortTakenIgnoresTheProxyBeingEdited() {
        let p = ProxyState(name: "a", port: 3000, host: "a.localhost", provisioned: false, url: "")
        XCTAssertEqual(portTaken(3000, in: [p])?.name, "a")
        XCTAssertNil(portTaken(3000, in: [p], excluding: "a"))
    }

    // The leftmost label takes the suffix, so the copy is a sibling rather than a deeper host.
    func testCloneHostTakesTheFirstFreeName() {
        XCTAssertEqual(cloneHost("storybook.ui.localhost", taken: []), "storybook-copy.ui.localhost")
        XCTAssertEqual(cloneHost("shop.test", taken: ["shop-copy.test"]), "shop-copy-2.test")
    }
}
