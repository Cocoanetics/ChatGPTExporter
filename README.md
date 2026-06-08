# ChatGPT → Wiki Exporter (Safari Web Extension)

A Safari toolbar button that exports the ChatGPT conversation you're currently
viewing as **Markdown** — with **incremental top-ups** so you can re-run it on a
growing chat and only get the new messages.

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
3. [`extension/popup.js`](extension/popup.js) diffs the turns against a
   per-conversation **watermark** in `browser.storage.local`, then downloads a
   `.md` of just the new turns and copies it to the clipboard.

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
   (Drobnik KG)**, the same team as the Legal English app, with consistent bundle
   ids (`com.drobnik.chatgptexporter` for the app, `…​.Extension` for the
   extension). Just confirm Xcode is signed into that Apple ID under **Settings →
   Accounts** so it can issue the development certificate.
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
2. Click **Download .md** to write the file, or **Copy** to put the Markdown on
   the clipboard for pasting straight into your wiki.
3. **Download** writes `Title-YYYY-MM-DD-HH-MM.md` to your **Downloads** folder.
   The native handler writes it directly — so there's **no download prompt**, the
   filename is exact, and the bytes are UTF-8 (umlauts and emoji intact).

   > No save-location picker exists for Safari extensions, so the file always
   > lands in Downloads with the exact name. Both actions are incremental and
   > advance the watermark (below).

**Incremental pulls:** run it again later on the same chat and you get only the
messages added since last time. If nothing's new, it says so and downloads
nothing. The watermark lives in this Safari profile's extension storage, keyed
by conversation id — so do your top-ups from the same Mac/profile.

**Re-export everything:** tick **"Re-export the whole chat"** to ignore the
watermark and dump the full conversation again (this also resets the watermark).

**Download images:** tick **"Download images"** and click Download — instead of a
lone `.md`, you get a folder `~/Downloads/<Title>-<ts>/` with `conversation.md`
(image links rewritten to `images/…`) and an `images/` folder. The native handler
fetches each picture directly (no CORS) with a progress bar. This is a
whole-thread snapshot and doesn't touch the incremental watermark.

**Raw JSON (tune the cleanup):** hold **⌥ Option** while clicking Download or
Copy — both buttons switch to the raw `/backend-api/conversation` response
(`…-raw.json`) instead of Markdown: the full mapping tree with every
`content_type` and metadata field. Inspect it to spot new artifacts to strip
(citations, `:::` directives, …), then refine the `stripCitations` /
`stripDirectives` rules in `extension/exporter.js` (use `tools/render-md.mjs` to
validate offline). The raw export ignores the watermark.

## Limitations

- **Images** are `_[image omitted]_` in a plain `.md`; tick **Download images** to
  snapshot the whole thread into a folder with the pictures fetched natively and
  the links rewritten to `images/…`. The image-pointer parsing is defensive and
  may need tuning per ChatGPT's current shapes (use ⌥ Download JSON to inspect).
- **Edits/regenerations re-emit a tail.** If an earlier message is edited, every
  message after it gets a new id and exports again as "new" — correct, since the
  thread genuinely changed, but worth knowing. Pure appends give just the new turns.
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
