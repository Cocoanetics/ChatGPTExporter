//
//  SafariWebExtensionHandler.swift
//  ChatGPT Exporter Extension
//
//  Created by Oliver Drobnik on 08.06.26.
//

import Foundation
import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        // The download action is async, so complete the request from the
        // handler's callback rather than synchronously.
        Self.handle(message: message) { result in
            let response = NSExtensionItem()
            if #available(macOS 11.0, *) {
                response.userInfo = [SFExtensionMessageKey: result]
            } else {
                response.userInfo = ["message": result]
            }
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
    }

    /// Routes a message from the extension's JS:
    ///   { action: "save",     filename, text, dir? }  -> write a UTF-8 file
    ///   { action: "download", url, filename, dir? }   -> fetch a URL to a file
    /// Files land under ~/Downloads (optionally in subfolder `dir`). Returns
    /// `{ ok, path }` or `{ ok: false, error }`.
    private static func handle(message: Any?, completion: @escaping ([String: Any]) -> Void) {
        guard let dict = message as? [String: Any] else {
            return completion(["ok": false, "error": "Malformed message."])
        }
        switch dict["action"] as? String {
        case "save":
            guard let text = dict["text"] as? String, let filename = dict["filename"] as? String else {
                return completion(["ok": false, "error": "Missing filename or text."])
            }
            completion(writeText(text, filename: filename, dir: dict["dir"] as? String))
        case "download":
            guard let urlString = dict["url"] as? String, let url = URL(string: urlString),
                  let filename = dict["filename"] as? String else {
                return completion(["ok": false, "error": "Missing url or filename."])
            }
            download(from: url, filename: filename, dir: dict["dir"] as? String,
                     token: dict["token"] as? String, completion: completion)
        case "ping":
            completion(["ok": true, "pong": true])
        default:
            completion(["ok": false, "error": "Unknown action."])
        }
    }

    /// Resolves a sanitized destination under ~/Downloads, creating any
    /// intermediate folders. Path components of "", "." and ".." are dropped so
    /// a crafted name can't escape Downloads.
    private static func destination(filename: String, dir: String?, unique: Bool) -> URL? {
        guard let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            return nil
        }
        let prefix = dir.map { $0 + "/" } ?? ""
        let relative = prefix + filename
        let components = relative.split(separator: "/").map { String($0) }
        let parts = components.filter { $0 != "." && $0 != ".." }
        guard !parts.isEmpty else { return nil }

        var url = downloads
        for part in parts { url.appendPathComponent(part) }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return unique ? uniqueURL(url) : url
    }

    private static func writeText(_ text: String, filename: String, dir: String?) -> [String: Any] {
        guard let data = text.data(using: .utf8) else {
            return ["ok": false, "error": "Could not encode the text as UTF-8."]
        }
        // Non-clobbering only for a bare top-level file; folder exports overwrite.
        guard let url = destination(filename: filename, dir: dir, unique: dir == nil) else {
            return ["ok": false, "error": "Could not resolve the Downloads path."]
        }
        do {
            try data.write(to: url, options: .atomic)
            return ["ok": true, "path": url.path]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    /// Structured failure so the JS side can tell retryable failures (expired
    /// signed URL, network blip, 5xx) from permanent ones (404, disk full)
    /// instead of collapsing everything into an opaque string.
    private static func failure(_ error: String, code: String, status: Int? = nil,
                                retryable: Bool) -> [String: Any] {
        var out: [String: Any] = ["ok": false, "error": error, "code": code, "retryable": retryable]
        if let status = status { out["status"] = status }
        return out
    }

    /// Dedicated session instead of URLSession.shared: shared's 7-day resource
    /// timeout would let one trickling connection wedge a JS download-pool slot
    /// (and, via the extension's single-job guard, block all future exports).
    /// The delegate strips Authorization when a redirect leaves the original
    /// host, so the ChatGPT bearer token is never replayed to arbitrary targets.
    private static let redirectSanitizer = RedirectSanitizer()
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60    // idle timeout between reads
        config.timeoutIntervalForResource = 300  // hard cap per file
        return URLSession(configuration: config, delegate: redirectSanitizer, delegateQueue: nil)
    }()

    private static func download(from url: URL, filename: String, dir: String?, token: String?,
                                 completion: @escaping ([String: Any]) -> Void) {
        guard let dest = destination(filename: filename, dir: dir, unique: false) else {
            return completion(failure("Could not resolve the Downloads path.", code: "io", retryable: false))
        }
        var request = URLRequest(url: url)
        if let token = token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let task = session.downloadTask(with: request) { tempURL, response, error in
            if let urlError = error as? URLError {
                let transient: [URLError.Code] = [.timedOut, .networkConnectionLost,
                                                  .notConnectedToInternet, .cannotConnectToHost,
                                                  .dnsLookupFailed]
                return completion(failure(urlError.localizedDescription,
                                          code: urlError.code == .timedOut ? "timeout" : "network",
                                          retryable: transient.contains(urlError.code)))
            }
            if let error = error {
                return completion(failure(error.localizedDescription, code: "network", retryable: true))
            }
            let http = response as? HTTPURLResponse
            if let http = http, !(200..<300).contains(http.statusCode) {
                // 401/403 usually means the pre-signed URL expired mid-export;
                // 408/429/5xx are transient. 404 and friends are not worth a retry.
                let retryable = [401, 403, 408, 429].contains(http.statusCode) || http.statusCode >= 500
                return completion(failure("HTTP \(http.statusCode)", code: "http",
                                          status: http.statusCode, retryable: retryable))
            }
            guard let tempURL = tempURL else {
                return completion(failure("No data received.", code: "network", retryable: true))
            }
            // A 200 with an HTML body where a binary was expected is almost
            // always a styled error page (expired link, login wall) — failing
            // beats saving it verbatim as chart.png and counting a success.
            let ext = dest.pathExtension.lowercased()
            if let mime = http?.mimeType, mime == "text/html", ext != "html", ext != "htm" {
                return completion(failure("Got an HTML page instead of the file.",
                                          code: "content", retryable: true))
            }
            do {
                if FileManager.default.fileExists(atPath: dest.path) {
                    // Atomic replace: concurrent writers to one destination can't
                    // interleave a remove and a move into corruption.
                    _ = try FileManager.default.replaceItemAt(dest, withItemAt: tempURL)
                } else {
                    do {
                        try FileManager.default.moveItem(at: tempURL, to: dest)
                    } catch CocoaError.fileWriteFileExists {
                        // Lost a race with a concurrent download of the same name.
                        _ = try FileManager.default.replaceItemAt(dest, withItemAt: tempURL)
                    }
                }
                completion(["ok": true, "path": dest.path])
            } catch {
                completion(failure(error.localizedDescription, code: "io", retryable: false))
            }
        }
        task.resume()
    }

    /// Strips the Authorization header when a redirect crosses to a different
    /// host, so the ChatGPT bearer token is never forwarded to arbitrary
    /// redirect targets (URLSession would otherwise re-send it).
    final class RedirectSanitizer: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            var request = request
            if request.url?.host != task.originalRequest?.url?.host {
                request.setValue(nil, forHTTPHeaderField: "Authorization")
            }
            completionHandler(request)
        }
    }

    /// If the target exists, insert " 2", " 3", … before the extension.
    private static func uniqueURL(_ url: URL) -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) { return url }
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        var i = 2
        while true {
            let name = ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"
            let candidate = dir.appendingPathComponent(name)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            i += 1
        }
    }
}
