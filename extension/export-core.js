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

// Local wall-clock time (not UTC — filenames shouldn't carry yesterday's date
// for an evening export), with seconds: minute precision made two exports in
// the same minute collide on one filename, which masked accidental duplicates
// as " 2" copies and silently merged same-minute folder exports.
function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}
function safeName(title) {
  const cleaned = title
    .replace(/[\\/:*?"<>|]+/g, "_")
    // Leading dots make Finder-hidden files (a chat titled ".zshrc tweaks"
    // would "vanish" from Downloads); trailing dots/spaces are awkward on
    // other filesystems.
    .replace(/^[.\s]+|[.\s]+$/g, "");
  // Slice by code point, not UTF-16 unit — cutting a surrogate pair in half
  // yields a lone surrogate that breaks the native-message serialization.
  return [...cleaned].slice(0, 80).join("") || "chatgpt";
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

// Native handler fetches `url` (with the bearer token) and writes it. Failures
// carry the native side's { code, status, retryable } so callers can retry
// transient ones (expired signed URL, network blip) but not permanent ones.
// The JS-side deadline is a backstop for a wedged native call, which would
// otherwise hold one of the download-pool slots forever — the native session's
// own resource timeout (300s) is the primary guard.
async function downloadViaNative(url, filename, dir, token) {
  const NATIVE_DEADLINE_MS = 6 * 60 * 1000;
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error("native download timed out");
      e.code = "timeout";
      e.retryable = true;
      reject(e);
    }, NATIVE_DEADLINE_MS);
  });
  try {
    const resp = await Promise.race([
      browser.runtime.sendNativeMessage(NATIVE_APP, { action: "download", url, filename, dir, token }),
      deadline,
    ]);
    if (!resp || !resp.ok) {
      const e = new Error((resp && resp.error) || "file download failed");
      if (resp) {
        e.code = resp.code;
        e.status = resp.status;
        e.retryable = !!resp.retryable;
      }
      throw e;
    }
    return resp.path;
  } finally {
    clearTimeout(timer);
  }
}
