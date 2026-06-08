//
//  SafariWebExtensionHandler.swift
//  ChatGPT Exporter Extension
//
//  Created by Oliver Drobnik on 08.06.26.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        let result = Self.handle(message: message)

        let response = NSExtensionItem()
        if #available(macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: result]
        } else {
            response.userInfo = ["message": result]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }

    /// Routes a message from the extension's JS. The popup sends
    /// `{ action: "save", filename, text }`; we write the file to the user's
    /// Downloads folder (granted by the downloads.read-write entitlement) and
    /// return `{ ok, path }` so the popup can confirm with the real location.
    private static func handle(message: Any?) -> [String: Any] {
        guard let dict = message as? [String: Any] else {
            return ["ok": false, "error": "Malformed message."]
        }
        switch dict["action"] as? String {
        case "save":
            guard let text = dict["text"] as? String,
                  let filename = dict["filename"] as? String else {
                return ["ok": false, "error": "Missing filename or text."]
            }
            return save(text: text, filename: filename)
        case "ping":
            return ["ok": true, "pong": true]
        default:
            return ["ok": false, "error": "Unknown action."]
        }
    }

    private static func save(text: String, filename: String) -> [String: Any] {
        // Use only the last path component and neutralise separators so a crafted
        // name can't escape the Downloads folder.
        var name = (filename as NSString).lastPathComponent.replacingOccurrences(of: "/", with: "_")
        if name.isEmpty || name == "." || name == ".." { name = "chatgpt-export.md" }

        guard let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else {
            return ["ok": false, "error": "Could not locate the Downloads folder."]
        }
        guard let data = text.data(using: .utf8) else {
            return ["ok": false, "error": "Could not encode the text as UTF-8."]
        }

        let url = uniqueURL(downloads.appendingPathComponent(name))
        do {
            try data.write(to: url, options: .atomic)
            return ["ok": true, "path": url.path]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    /// If the target exists, insert " 2", " 3", … before the extension so we
    /// never clobber a previous export.
    private static func uniqueURL(_ url: URL) -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) { return url }
        let dir = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let base = url.deletingPathExtension().lastPathComponent
        var i = 2
        while true {
            let suffix = ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"
            let candidate = dir.appendingPathComponent(suffix)
            if !fm.fileExists(atPath: candidate.path) { return candidate }
            i += 1
        }
    }

}
