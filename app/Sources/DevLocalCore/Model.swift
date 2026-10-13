import Foundation

// Codable mirrors of what the server sends (server/src/shared/types.ts). Decoding ignores
// fields not declared here, and every field the server may leave out is optional.

public struct ProxyState: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var port: Int
    public var path: String?
    public var command: String?
    public var custom: Bool?
    public var title: String?
    public var host: String
    public var provisioned: Bool
    public var url: String
    public var devRunning: Bool?
    /** Something in /etc/hosts points this host at loopback. */
    public var hostsEntry: Bool?
    /** That entry is inside the managed block, so it is ours to remove. */
    public var hostsManaged: Bool?
    /** Not a `.localhost` name, and nothing resolves it. */
    public var needsHosts: Bool?

    public var id: String { name }

    public init(
        name: String, port: Int, path: String? = nil, command: String? = nil, custom: Bool? = nil,
        title: String? = nil, host: String, provisioned: Bool, url: String,
        devRunning: Bool? = nil, hostsEntry: Bool? = nil, hostsManaged: Bool? = nil, needsHosts: Bool? = nil
    ) {
        self.name = name
        self.port = port
        self.path = path
        self.command = command
        self.custom = custom
        self.title = title
        self.host = host
        self.provisioned = provisioned
        self.url = url
        self.devRunning = devRunning
        self.hostsEntry = hostsEntry
        self.hostsManaged = hostsManaged
        self.needsHosts = needsHosts
    }

    /// The label the menu and the Settings rows show: the title when there is one, the host otherwise.
    public var label: String {
        guard let title, !title.isEmpty else { return host }
        return title
    }
}

public struct NginxState: Codable, Equatable, Sendable {
    public var installed: Bool
    public var bin: String?
    public var version: String?
    public var running: Bool
    public var installCmd: String?

    public init(installed: Bool, bin: String? = nil, version: String? = nil, running: Bool, installCmd: String? = nil) {
        self.installed = installed
        self.bin = bin
        self.version = version
        self.running = running
        self.installCmd = installCmd
    }
}

public struct CertState: Codable, Equatable, Sendable {
    public var exists: Bool
    /// "mkcert" or "openssl".
    public var method: String?
    public var version: String?
    public var mkcertAvailable: Bool
    public var hosts: [String]
    /// Only a self-signed openssl cert needs trusting by hand.
    public var trustCmd: String?

    public init(exists: Bool, method: String? = nil, version: String? = nil, mkcertAvailable: Bool, hosts: [String] = [], trustCmd: String? = nil) {
        self.exists = exists
        self.method = method
        self.version = version
        self.mkcertAvailable = mkcertAvailable
        self.hosts = hosts
        self.trustCmd = trustCmd
    }
}

public struct AppState: Codable, Equatable, Sendable {
    public var proxies: [ProxyState]
    public var nginx: NginxState
    public var cert: CertState?
    public var baseDir: String?

    public init(proxies: [ProxyState], nginx: NginxState, cert: CertState? = nil, baseDir: String? = nil) {
        self.proxies = proxies
        self.nginx = nginx
        self.cert = cert
        self.baseDir = baseDir
    }
}

/// One dev server the server started, running or finished. Only what the menu needs.
public struct ProcSummary: Codable, Equatable, Sendable {
    public var name: String
    public var running: Bool
    public var exitCode: Int?
    public var signal: String?

    public init(name: String, running: Bool, exitCode: Int? = nil, signal: String? = nil) {
        self.name = name
        self.running = running
        self.exitCode = exitCode
        self.signal = signal
    }
}

/// The whole of one started process, for the console's list.
public struct ProcState: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var running: Bool
    public var pid: Int?
    public var cmd: String
    public var cwd: String
    public var startedAt: Double
    public var exitedAt: Double?
    public var exitCode: Int?
    public var signal: String?
    public var bytes: Int

    public var id: String { name }

    public init(name: String, running: Bool, pid: Int? = nil, cmd: String, cwd: String, startedAt: Double, exitedAt: Double? = nil, exitCode: Int? = nil, signal: String? = nil, bytes: Int) {
        self.name = name
        self.running = running
        self.pid = pid
        self.cmd = cmd
        self.cwd = cwd
        self.startedAt = startedAt
        self.exitedAt = exitedAt
        self.exitCode = exitCode
        self.signal = signal
        self.bytes = bytes
    }
}

/// The push over /ws. `rev` changes whenever proxies.json is written.
public struct LiveStatus: Codable, Equatable, Sendable {
    public var type: String
    public var rev: Int
    public var nginxRunning: Bool
    public var dev: [String: Bool]
    public var procs: [ProcSummary]

    public init(type: String = "status", rev: Int, nginxRunning: Bool, dev: [String: Bool], procs: [ProcSummary]) {
        self.type = type
        self.rev = rev
        self.nginxRunning = nginxRunning
        self.dev = dev
        self.procs = procs
    }
}

/// A process's output over /ws: the whole buffer when `reset`, otherwise a chunk to append.
public struct LogFrame: Codable, Equatable, Sendable {
    public var type: String
    public var name: String
    public var text: String
    public var reset: Bool?

    public init(type: String = "log", name: String, text: String, reset: Bool? = nil) {
        self.type = type
        self.name = name
        self.text = text
        self.reset = reset
    }
}

/// The file as two blocks: what was there before us, and what we maintain.
public struct HostsFile: Codable, Equatable, Sendable {
    public var path: String
    public var ok: Bool
    public var error: String?
    public var original: String
    public var managed: String
}

public struct ApplyResult: Codable, Equatable, Sendable {
    public var ok: Bool
    public var step: String?
    public var out: String?
}

/// The proxy an add or edit saved, as the server answers with it: the stored fields plus the
/// host, not a full ProxyState (no `provisioned` or `url`). The rest of it is in `state`.
public struct SavedProxy: Codable, Equatable, Sendable {
    public var name: String
    public var host: String
}

/// What every action route answers: the parts it has, and the state as it stands after.
public struct ActionResult: Codable, Equatable, Sendable {
    public var ok: Bool?
    public var error: String?
    public var applied: ApplyResult?
    public var state: AppState?
    public var proxy: SavedProxy?
    public var previousHost: String?
    /** From /api/proxies/:name/dev. */
    public var already: Bool?
    /** From /api/proxies/:name/stop. */
    public var stopped: Bool?
    public var path: String?
    public var canceled: Bool?
    /** From /api/hosts/fix: whether /etc/hosts needs a change, and the Terminal script that makes it. */
    public var changed: Bool?
    public var script: String?

    public init(ok: Bool? = nil, error: String? = nil) {
        self.ok = ok
        self.error = error
    }

    /// Whether it worked: `ok`, and `applied.ok` when there is one.
    public var succeeded: Bool { (ok ?? false) && (applied?.ok ?? true) }
    /// What to tell the user when it didn't.
    public var failure: String { error ?? applied?.out ?? "Request failed." }
}
