import Foundation
import DevLocalCore

/// The /ws socket: the status push, decoded, and a watched process's output. Reconnects
/// with a backoff capped at ten seconds, so a server that restarts is picked up without the
/// app being relaunched; a watch survives the reconnect (it is re-sent on open).
@MainActor
final class LiveFeed {
    var onStatus: ((LiveStatus) -> Void)?
    var onLog: ((LogFrame) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var backoff: TimeInterval = 1
    private var wanted = false
    private var watching: String?

    func start() {
        wanted = true
        connect()
    }

    func stop() {
        wanted = false
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    /// Ask for a process's output (the whole buffer first, marked `reset`, then every chunk as
    /// it arrives), or for none. Only the console does this, and only while it is open.
    func watch(_ name: String?) {
        watching = name
        sendWatch()
    }

    private func sendWatch() {
        guard let task, let data = try? JSONEncoder().encode(["watch": watching]),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func connect() {
        guard wanted, let url = URL(string: "ws://127.0.0.1:\(ServerHost.port)/ws") else { return }
        let socket = URLSession.shared.webSocketTask(with: url)
        task = socket
        socket.resume()
        if watching != nil { sendWatch() }
        receive(on: socket)
    }

    private func receive(on socket: URLSessionWebSocketTask) {
        socket.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.task === socket else { return }
                switch result {
                case let .success(message):
                    self.backoff = 1
                    self.onConnectionChange?(true)
                    if case let .string(text) = message, let data = text.data(using: .utf8) {
                        if let frame = try? JSONDecoder().decode(LogFrame.self, from: data), frame.type == "log" {
                            self.onLog?(frame)
                        } else if let status = try? JSONDecoder().decode(LiveStatus.self, from: data) {
                            self.onStatus?(status)
                        }
                    }
                    self.receive(on: socket)
                case .failure:
                    self.onConnectionChange?(false)
                    self.task = nil
                    self.retry()
                }
            }
        }
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
