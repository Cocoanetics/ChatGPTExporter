// export-core.js
//
// Shared, DOM-free helpers used by BOTH the popup (popup.js) and the background
// service worker (background.js): Markdown assembly + the native-handler IPC
// calls that write files to ~/Downloads. It's loaded via <script> in popup.html
// and via importScripts() in background.js, so everything here lands in the
// global scope of whichever context loads it.

const NATIVE_APP = "com.drobnik.chatgptexporter";

function timestamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}
function safeName(title) {
  return title.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "chatgpt";
}

// Append GFM footnote definitions for the citations referenced in `md`.
function appendFootnotes(md, notes) {
  if (!notes || !notes.length) return md;
  const used = new Set([...md.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])));
  const defs = notes
    .filter((n) => used.has(n.num))
    .map((n) => `[^${n.num}]: [${n.title}](${n.url})`);
  return defs.length ? `${md}\n${defs.join("\n")}\n` : md;
}

function buildMarkdown(result) {
  const md = `# ${result.title}\n\n` + result.turns.map((t) => t.md).join("\n");
  return appendFootnotes(md, result.footnotes);
}

// Native handler writes a UTF-8 text file to ~/Downloads/[dir/]filename.
async function saveViaNative(filename, text, dir) {
  const resp = await browser.runtime.sendNativeMessage(NATIVE_APP, { action: "save", filename, text, dir });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "native save failed");
  return resp.path;
}

// Native handler fetches `url` (with the bearer token) and writes it.
async function downloadViaNative(url, filename, dir, token) {
  const resp = await browser.runtime.sendNativeMessage(NATIVE_APP, { action: "download", url, filename, dir, token });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "file download failed");
  return resp.path;
}
