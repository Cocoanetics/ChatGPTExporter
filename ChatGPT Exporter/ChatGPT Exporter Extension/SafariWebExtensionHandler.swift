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
            download(from: url, filename: filename, dir: dict["dir"] as? String, completion: completion)
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

    private static func download(from url: URL, filename: String, dir: String?,
                                 completion: @escaping ([String: Any]) -> Void) {
        guard let dest = destination(filename: filename, dir: dir, unique: false) else {
            return completion(["ok": false, "error": "Could not resolve the Downloads path."])
        }
        let task = URLSession.shared.downloadTask(with: url) { tempURL, response, error in
            if let error = error {
                return completion(["ok": false, "error": error.localizedDescription])
            }
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                return completion(["ok": false, "error": "HTTP \(http.statusCode)"])
            }
            guard let tempURL = tempURL else {
                return completion(["ok": false, "error": "No data received."])
            }
            do {
                if FileManager.default.fileExists(atPath: dest.path) {
                    try FileManager.default.removeItem(at: dest)
                }
                try FileManager.default.moveItem(at: tempURL, to: dest)
                completion(["ok": true, "path": dest.path])
            } catch {
                completion(["ok": false, "error": error.localizedDescription])
            }
        }
        task.resume()
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
