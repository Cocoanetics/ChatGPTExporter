# ChatGPT Exporter (Safari Web Extension)

[![Build](https://github.com/Cocoanetics/ChatGPTExporter/actions/workflows/build.yml/badge.svg)](https://github.com/Cocoanetics/ChatGPTExporter/actions/workflows/build.yml)

A Safari toolbar button that exports the ChatGPT conversation you're currently
viewing as **Markdown** — the whole chat, with web-search citations turned into
footnotes and an optional snapshot of its images and files.

It works by injecting a small function into the open `chatgpt.com` page, which
calls ChatGPT's own `/backend-api/conversation/{id}` using the session you're
already logged into (no tokens, no passwords, nothing leaves your machine).

## How it works

1. The popup injects [`extension/exporter.js`](extension/exporter.js) into the
   active tab via `scripting.executeScript`. Running in the page's origin, its
   `fetch` calls carry your ChatGPT session cookies.
2. It fetches the conversation, walks the **active path** (`current_node` →
   parent → root, reversed — the thread you actually see, not abandoned
   regenerations), and renders each user/assistant turn. Assistant text is
   already Markdown, so this is mostly stitching + dropping the `【…】` citation
   markers.
3. [`extension/popup.js`](extension/popup.js) stitches the turns into a single
   Markdown document — web-search citations appended as footnotes — and either
   saves it to `~/Downloads` via the native handler or copies it to the clipboard.

## Project layout

```
ChatGPTExporter/
├── extension/                 ← the Web Extension (edit these)
│   ├── manifest.json
│   ├── popup.html / popup.css / popup.js
│   ├── exporter.js            ← injected into the page; does the actual export
│   └── images/                ← generated icons
├── tools/make-icons.py        ← regenerates the placeholder icons (pure stdlib)
├── ChatGPT Exporter/          ← generated Xcode app wrapper (references ../extension)
│   └── ChatGPT Exporter.xcodeproj
└── README.md
```

The Xcode project **references** `extension/` rather than copying it, so editing
the JS/HTML and rebuilding picks up your changes — `extension/` stays the single
source of truth.

## Build & install

1. Open `ChatGPT Exporter/ChatGPT Exporter.xcodeproj` in Xcode.
2. Signing is **already configured** — automatic style, team **`Z7L2YCUH45`
   (Drobnik KG)**, with consistent bundle
   ids (`com.drobnik.chatgptexporter` for the app, `…​.Extension` for the
   extension). Just confirm Xcode is signed into that Apple ID under **Settings →
   Accounts** so it can issue the development certificate.

   > **Forking?** Select **your** team on all four build configs (Signing &
   > Capabilities → Team) and swap the bundle ids for your own reverse-DNS — or
   > build unsigned for a quick local test, the way
   > [CI](.github/workflows/build.yml) does (`CODE_SIGNING_ALLOWED=NO`).
3. **Run** (⌘R). The container app launches — it's just a shell whose only job is
   to register the extension with Safari.
4. In Safari: **Settings → Advanced → "Show features for web developers"**, then
   **Settings → Developer → "Allow unsigned extensions"** (fallback only — with the
   configured team this is unnecessary; the toggle resets each Safari relaunch).
5. **Settings → Extensions →** enable **ChatGPT Exporter Extension**, and when
   prompted grant it access to **chatgpt.com** ("Always Allow on chatgpt.com").

A 🟢 button appears in the toolbar.

> The project builds and signs as-is (verified with `xcodebuild` — compiles,
> bundles, and passes embedded-binary validation). Signing with the configured
> team makes the extension stick permanently and skips the step-4 toggle.

## Usage

1. Open the conversation in Safari (the account that owns the chat).
2. Click **Download** to write the whole chat as `Title-YYYY-MM-DD-HH-MM.md` to
   your **Downloads** folder, or **Copy** to put the Markdown on the clipboard.
   The native handler writes the file directly — no download prompt, exact
   filename, UTF-8 (umlauts and emoji intact).

   > No save-location picker exists for Safari extensions, so the file always
   > lands in Downloads with the exact name.

Web-search **citations always become footnotes**: an inline `[^n]` where ChatGPT
showed each source chip, plus a `[^n]: [Title](url)` block at the end
(deduplicated by URL, anchored references only). Other ChatGPT annotations
(`:::` blocks, hidden tokens) are stripped.

**Download Files:** tick **"Download Files"** and click Download — instead of a
lone `.md`, you get a folder `~/Downloads/<Title>-<ts>/` with `conversation.md`
plus a `files/` folder of the conversation's **images, attachments (PDFs, …), and
code-interpreter–generated files** (`sandbox:` links). Images are inlined as
`![](files/…)`, other files as `📎 [name](files/…)` links; the native handler
fetches each one directly (no CORS) with a progress bar. Sandbox files are
ephemeral on ChatGPT's side, so very old chats may no longer have them.

**Raw JSON:** hold **⌥ Option** while clicking Download or Copy — both switch to
the raw `/backend-api/conversation` response (`…-raw.json`), the full mapping tree
with every `content_type` and metadata field. Handy for tuning the cleanup rules
in `extension/exporter.js` (use `tools/render-md.mjs` to render one offline).

## Limitations

- **Images & attachments** are `_[image omitted]_` / omitted in a plain `.md`; tick
  **Download Files** to snapshot the thread into a folder with images and files
  (PDFs, …) fetched natively. The pointer/attachment parsing is defensive and may
  need tuning per ChatGPT's current shapes (use ⌥ Download JSON to inspect).
- The export always reflects the **current active path** — edited/regenerated
  branches are followed to the visible leaf; abandoned variants are dropped.
- **macOS only**, as generated. Re-run the converter with `--ios-only`/without
  `--macos-only` to add an iPad/iPhone target.
- Hosts are `chatgpt.com` and `chat.openai.com`. Add others in
  `manifest.json` → `host_permissions` if needed.

## Regenerating

- Icons: `python3 tools/make-icons.py`
- Rebuild the Xcode wrapper from scratch (e.g. after changing app name/bundle id):
  ```
  xcrun safari-web-extension-converter extension \
    --project-location . --app-name "ChatGPT Exporter" \
    --bundle-identifier com.drobnik.chatgptexporter --swift --macos-only --force
  ```
  > Regenerating **resets signing**: the converter writes the app id as
  > `com.drobnik.ChatGPT-Exporter` (which no longer prefixes the extension id) and
  > drops the team. Re-apply afterward — app id back to `com.drobnik.chatgptexporter`,
  > and `DEVELOPMENT_TEAM = Z7L2YCUH45` on all four target build configs.

## License

MIT — see [LICENSE](LICENSE).
