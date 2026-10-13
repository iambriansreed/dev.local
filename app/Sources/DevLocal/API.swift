import Foundation
import DevLocalCore

/// The server's HTTP API, on its Unix socket (UnixSocket.swift). Every action route answers an
/// `ActionResult` whatever its status: a 400 carries the reason in `error`, so the body is
/// decoded for every status and only a failure to reach the server throws.
struct API {
    let socket: String

    init(socket: String = ServerHost.socketPath) {
        self.socket = socket
    }

    func state() async throws -> AppState {
        try await get("/api/state")
    }

    // MARK: Proxies

    struct ProxyInput: Encodable {
        var name: String
        var port: Int
        var path: String
        var command: String
        var title: String
        /// "name is a whole host": the server works out which kind it is.
        var custom = true
    }

    func addProxy(_ input: ProxyInput) async throws -> ActionResult {
        try await send("POST", "/api/proxies", body: input)
    }

    func updateProxy(_ name: String, _ input: ProxyInput) async throws -> ActionResult {
        try await send("PUT", "/api/proxies/\(escape(name))", body: input)
    }

    func deleteProxy(_ name: String) async throws -> ActionResult {
        try await send("DELETE", "/api/proxies/\(escape(name))")
    }

    func startDev(_ name: String) async throws -> ActionResult {
        try await send("POST", "/api/proxies/\(escape(name))/dev")
    }

    func stopDev(_ name: String) async throws -> ActionResult {
        try await send("POST", "/api/proxies/\(escape(name))/stop")
    }

    func restartDev(_ name: String) async throws -> ActionResult {
        try await send("POST", "/api/proxies/\(escape(name))/restart")
    }

    func openEditor(_ name: String) async throws -> ActionResult {
        try await send("POST", "/api/proxies/\(escape(name))/code")
    }

    // MARK: /etc/hosts

    func hostsFile() async throws -> HostsFile {
        try await get("/api/hosts")
    }

    /// Stage the new /etc/hosts and the Terminal script that explains and applies it.
    func fixHosts() async throws -> ActionResult {
        try await send("POST", "/api/hosts/fix")
    }

    // MARK: nginx and the certificate

    func startNginx() async throws -> ActionResult { try await send("POST", "/api/nginx/start") }
    func stopNginx() async throws -> ActionResult { try await send("POST", "/api/nginx/stop") }
    func reloadNginx() async throws -> ActionResult { try await send("POST", "/api/nginx/reload") }
    func provisionCert() async throws -> ActionResult { try await send("POST", "/api/cert") }
    func openConfigDir() async throws -> ActionResult { try await send("POST", "/api/config/open") }

    // MARK: Console

    struct ProcList: Decodable { var procs: [ProcState] }
    struct ProcLog: Decodable { var text: String }

    func procs() async throws -> [ProcState] {
        let list: ProcList = try await get("/api/procs")
        return list.procs
    }

    func procLog(_ name: String) async throws -> String {
        let log: ProcLog = try await get("/api/procs/\(escape(name))/log")
        return log.text
    }

    func clearProc(_ name: String) async throws {
        _ = try await send("POST", "/api/procs/\(escape(name))/clear")
    }

    // MARK: Plumbing

    private func escape(_ name: String) -> String {
        name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let response = try await UnixHTTP.request(socket: socket, method: "GET", path: path)
        guard (200..<300).contains(response.status) else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: response.body)
    }

    @discardableResult
    private func send(_ method: String, _ path: String, body: (some Encodable)? = Optional<[String: String]>.none) async throws -> ActionResult {
        let encoded = try body.map { try JSONEncoder().encode($0) }
        let response = try await UnixHTTP.request(socket: socket, method: method, path: path, body: encoded)
        return try JSONDecoder().decode(ActionResult.self, from: response.body)
    }
}
