import XCTest
@testable import DevLocalCore

final class ParsersTests: XCTestCase {
    // A macOS app's executable sits in its bundle; the bundle name identifies the terminal.
    func testOwnerFromAncestry() {
        XCTAssertEqual(
            ownerKind(ancestors: ["/bin/zsh", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]),
            .terminal
        )
        XCTAssertEqual(
            ownerKind(ancestors: ["/bin/zsh", "/Applications/iTerm.app/Contents/MacOS/iTerm2"]),
            .iterm
        )
        XCTAssertEqual(
            ownerKind(ancestors: ["/bin/zsh", "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"]),
            .otherApp(name: "Code Helper")
        )
        XCTAssertEqual(
            ownerKind(ancestors: ["/bin/zsh", "/opt/homebrew/bin/tmux"]),
            .tmux
        )
    }

    // A process launched by launchd has no app above it.
    func testNoAppMeansNone() {
        XCTAssertEqual(ownerKind(ancestors: ["/sbin/launchd", "/usr/libexec/something"]), .none)
    }

    func testTTYFromPs() {
        XCTAssertEqual(parseTTY(psOutput: "ttys004 1234\n"), "ttys004")
        XCTAssertNil(parseTTY(psOutput: "?? 1\n"))
        XCTAssertNil(parseTTY(psOutput: ""))
    }

    func testListenerPIDFromLsof() {
        XCTAssertEqual(parseListenerPID(lsofOutput: "6816\n"), 6816)
        XCTAssertEqual(parseListenerPID(lsofOutput: "6816\n6817\n"), 6816)
        XCTAssertNil(parseListenerPID(lsofOutput: ""))
    }

    // A profile may print before the PATH; the PATH is the last line that looks like one.
    func testLoginPathIgnoresProfileNoise() {
        let output = "Welcome to fish\n/opt/homebrew/bin:/usr/bin:/bin\n"
        XCTAssertEqual(parseLoginPath(output), "/opt/homebrew/bin:/usr/bin:/bin")
        XCTAssertNil(parseLoginPath(""))
    }
}
