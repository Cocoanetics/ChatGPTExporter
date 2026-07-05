// export-core.js
//
// Shared, DOM-free helpers used by BOTH the popup (popup.js) and the background
// service worker (background.js): Markdown assembly + the native-handler IPC
// calls that write files to ~/Downloads. It's loaded via <script> in popup.html
// and via importScripts() in background.js, so everything here lands in the
// global scope of whichever context loads it.

const NATIVE_APP = "com.drobnik.chatgptexporter";

// --- Durable job state -------------------------------------------------------
// Safari suspends an MV3 service worker aggressively — even mid-await — so the
// in-flight export is journaled here rather than held in worker memory. The
// worker writes every status/progress change plus a heartbeat; the popup polls
// the journal as ground truth while busy (port messages are just the fast
// path); a freshly started worker reconciles an orphaned entry into an
// "interrupted" report. storage.session is preferred (gone with the browser
// session); older Safari falls back to storage.local.

const JOB_STALE_MS = 45000; // no heartbeat for this long ⇒ the job's worker is dead

const jobStore = {
  area() {
    const s = typeof browser !== "undefined" && browser.storage;
    return (s && (s.session || s.local)) || null;
  },
  async get(key) {
    const a = this.area();
    if (!a) return null;
    try {
      const o = await a.get(key);
      return (o && o[key]) || null;
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    const a = this.area();
    if (!a) return;
    try {
      await a.set({ [key]: value });
    } catch (e) {}
  },
  async remove(key) {
    const a = this.area();
    if (!a) return;
    try {
      await a.remove(key);
    } catch (e) {}
  },
};

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
