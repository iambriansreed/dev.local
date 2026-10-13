import Foundation
import DevLocalCore

/// The /ws push, over the server's Unix socket (UnixWebSocket): the status, decoded, and a
/// watched process's output. Reconnects with a backoff capped at ten seconds, so a server
/// that restarts is picked up without the app being relaunched; a watch survives the
/// reconnect (it is re-sent on open).
@MainActor
final class LiveFeed {
    var onStatus: ((LiveStatus) -> Void)?
    var onLog: ((LogFrame) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private var connection: UnixWebSocket?
    /// Bumped on every connect and stop, so a connection that ends after it was replaced
    /// can tell it is no longer the current one.
    private var generation = 0
    private var backoff: TimeInterval = 1
    private var wanted = false
    private var watching: String?

    func start() {
        wanted = true
        connect()
    }

    func stop() {
        wanted = false
        generation += 1
        connection?.close()
        connection = nil
    }

    /// Ask for a process's output (the whole buffer first, marked `reset`, then every chunk as
    /// it arrives), or for none. Only the console does this, and only while it is open.
    func watch(_ name: String?) {
        watching = name
        sendWatch()
    }

    private func sendWatch() {
        guard let connection, let data = try? JSONEncoder().encode(["watch": watching]),
              let text = String(data: data, encoding: .utf8) else { return }
        connection.send(text)
    }

    private func connect() {
        guard wanted else { return }
        generation += 1
        let current = generation
        Task {
            do {
                let opened = try await UnixWebSocket.open(
                    socket: ServerHost.socketPath,
                    onText: { [weak self] text in self?.received(text, generation: current) },
                    onClose: { [weak self] in self?.ended(generation: current) }
                )
                guard current == generation else {
                    opened.close()
                    return
                }
                connection = opened
                if watching != nil { sendWatch() }
            } catch {
                ended(generation: current)
            }
        }
    }

    private func received(_ text: String, generation current: Int) {
        guard current == generation, let data = text.data(using: .utf8) else { return }
        backoff = 1
        onConnectionChange?(true)
        if let frame = try? JSONDecoder().decode(LogFrame.self, from: data), frame.type == "log" {
            onLog?(frame)
        } else if let status = try? JSONDecoder().decode(LiveStatus.self, from: data) {
            onStatus?(status)
        }
    }

    private func ended(generation current: Int) {
        guard current == generation else { return }
        connection = nil
        onConnectionChange?(false)
        retry()
    }

    private func retry() {
        guard wanted else { return }
        let delay = backoff
        backoff = min(backoff * 2, 10)
        Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            connect()
        }
    }
}
