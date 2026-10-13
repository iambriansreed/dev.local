import Foundation

// The add and edit form's rules (the server applies them again on arrival): what a typed domain means, what a port may be, and the name a clone gets.

public let hostHint = "A domain is lowercase letters, numbers, dashes and dots, e.g. myapp.localhost."
public let portHint = "A port is a number between 1 and 65535, e.g. 3000."
public let noAppPathHint = "Add an app path (via Edit) to start and stop the dev server from here"
public let localhostSuffix = ".localhost"

/// A single DNS label: lowercase letters, digits and dashes, with no leading or trailing dash.
private func validLabel(_ label: Substring) -> Bool {
    guard let first = label.first, let last = label.last, first != "-", last != "-" else { return false }
    return label.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") }
}

/// The name field holds the whole host, so what you type is what gets served. A bare name is
/// the common case, so a value with no dot gets `.localhost` added. A pasted URL is read as the
/// domain inside it: the scheme and everything from the first slash on are dropped.
public func normalizeHost(_ raw: String) -> String {
    var host = raw.trimmingCharacters(in: .whitespaces).lowercased()
    if let scheme = host.firstMatch(of: /^[a-z][a-z0-9+.-]*:\/\//) {
        host = String(host[scheme.range.upperBound...])
    }
    if let cut = host.firstIndex(where: { "/?#".contains($0) }) {
        host = String(host[..<cut])
    }
    while host.hasSuffix(".") { host.removeLast() }
    if !host.isEmpty, !host.contains(".") { host += localhostSuffix }
    return host
}

/// The name the server stores: `.localhost` stripped, since it is implied for every ordinary proxy.
public func nameFromHost(_ host: String) -> String {
    host.hasSuffix(localhostSuffix) ? String(host.dropLast(localhostSuffix.count)) : host
}

/// Every label valid, and at least two of them: a single-label host has no TLD and would collide
/// with a machine name on the network.
public func validHost(_ host: String) -> Bool {
    guard !host.isEmpty, host.contains(".") else { return false }
    return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy(validLabel)
}

/// What the Domain field says under itself about the top-level domain typed. Neither kind
/// blocks saving.
public struct DomainWarning: Equatable, Sendable {
    public enum Severity: Equatable, Sendable {
        /// Works, with a catch worth knowing: shown in grey.
        case note
        /// Will misbehave: shown in orange.
        case problem
    }
    public var severity: Severity
    public var text: String
}

/// The drawback of a host's top-level domain, if it has one worth saying.
///
/// `.local` is Bonjour's (RFC 6762): macOS sends the lookup to mDNS too, so a name that is in
/// /etc/hosts still stalls about 5 seconds whenever the IPv6 address is asked for, which
/// browsers do. `.localhost` resolves on its own, but Google refuses `*.localhost` OAuth
/// redirect URIs (it wants a public top-level domain) and Sign in with Apple refuses localhost.
public func domainWarning(_ host: String) -> DomainWarning? {
    if host.hasSuffix(".local") {
        return DomainWarning(severity: .problem, text: "`.local` is reserved for Bonjour. macOS asks your network first, so each visit can stall about 5 seconds before /etc/hosts answers, and a device with the same name can answer instead. Use `.localhost`, or a domain you own like local.iambrian.com.")
    }
    if host.hasSuffix(localhostSuffix) {
        return DomainWarning(severity: .note, text: "`*.localhost` domains work with no setup. Some sign-in providers won't redirect to them: Google rejects `.localhost` callback URLs and Apple rejects localhost entirely. Use a domain you own if this app needs OAuth callbacks, like local.iambrian.com.")
    }
    return nil
}

public func validPort(_ port: Int?) -> Bool {
    guard let port else { return false }
    return (1...65535).contains(port)
}

/// The proxy already on `port`, if there is one. `excluding` is the proxy being edited, so
/// keeping its own port isn't a clash with itself.
public func portTaken(_ port: Int, in proxies: [ProxyState], excluding: String? = nil) -> ProxyState? {
    proxies.first { $0.name != excluding && $0.port == port }
}

/// A free host for a copy of `host`. The leftmost label is the most specific one, so
/// storybook.ui.localhost clones to storybook-copy.ui.localhost and shop.test to shop-copy.test.
public func cloneHost(_ host: String, taken: [String]) -> String {
    let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
    guard let first = labels.first else { return host }
    let rest = labels.dropFirst()
    func nth(_ n: Int) -> String { ([n == 1 ? "\(first)-copy" : "\(first)-copy-\(n)"] + rest).joined(separator: ".") }
    var n = 1
    while taken.contains(nth(n)) { n += 1 }
    return nth(n)
}
