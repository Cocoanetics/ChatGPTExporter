// popup.js
//
// Drives the toolbar popup: injects pageExport() into the active ChatGPT tab,
// diffs the returned turns against this conversation's watermark in extension
// storage, and emits only the new Markdown (downloaded as a .md file and copied
// to the clipboard). Safari exposes the promise-based `browser.*` namespace.

const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("export");
const fullToggle = document.getElementById("full");
const debugToggle = document.getElementById("debug");

const storeKey = (convId) => `wikiExport:${convId}`;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Save via an anchor click in the popup, during the button's user gesture: that
// gesture is what makes Safari honor the `download` filename. (A programmatic
// click from the page has no gesture, so Safari ignores the name and saves the
// file as "Unknown" with no extension.) application/octet-stream forces a real
// download instead of an inline preview; the bytes are UTF-8, so umlauts and
// emoji stay intact. Trade-off: from the popup, Safari's one-time download
// prompt shows a blank "" source — just click Allow. (A page-initiated save
// would label the source "chatgpt.com" but then drop the filename.)
function saveFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function timestamp() {
  // 2026-06-08-14-30 — safe for filenames, sorts chronologically.
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

function safeName(title) {
  return title.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "chatgpt";
}

exportBtn.addEventListener("click", async () => {
  exportBtn.disabled = true;
  setStatus("Exporting…");

  try {
    const tab = await getActiveTab();
    if (tab && tab.url && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
      setStatus("Open this on a ChatGPT conversation tab first.", "err");
      return;
    }

    const debug = debugToggle.checked;

    // Run the exporter inside the page (carries the session cookies).
    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
        args: [debug],
      });
    } catch (e) {
      setStatus("Couldn't reach the page. Open a ChatGPT chat and try again.", "err");
      return;
    }

    const result = injection && injection.result;
    if (!result) {
      setStatus("No response from the page.", "err");
      return;
    }
    if (result.error) {
      setStatus(result.error, "err");
      return;
    }

    if (debug) {
      // Dump the full raw conversation JSON for tuning the cleanup rules.
      // Inspection, not a real export — leave the watermark untouched.
      saveFile(`${safeName(result.title)}-${timestamp()}-raw.json`, result.raw || "{}");
      setStatus(
        `✓ Saved raw JSON (${Math.round((result.raw || "").length / 1024)} KB). Tune cleanup, then re-run with Debug off.`,
        "ok"
      );
      return;
    }

    // Watermark diff: which turn ids has this conversation already exported?
    const key = storeKey(result.convId);
    const reExportAll = fullToggle.checked;
    const stored = reExportAll ? null : (await browser.storage.local.get(key))[key];
    const seen = new Set((stored && stored.exported) || []);
    const firstRun = seen.size === 0;

    const fresh = result.turns.filter((t) => !seen.has(t.id));
    if (fresh.length === 0) {
      setStatus("✓ Up to date — no new messages since the last pull.", "ok");
      return;
    }

    let markdown = fresh.map((t) => t.md).join("\n");
    if (firstRun) markdown = `# ${result.title}\n\n${markdown}`; // title only on the first pull

    // Clipboard first (the primary path for pasting into a wiki), then the file.
    let copied = true;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch (e) {
      copied = false;
    }
    saveFile(`${safeName(result.title)}-${timestamp()}.md`, markdown);

    // Advance the watermark.
    const merged = Array.from(new Set([...seen, ...fresh.map((t) => t.id)]));
    await browser.storage.local.set({ [key]: { exported: merged, updated: Date.now() } });

    const scope = firstRun ? "the whole chat" : `${fresh.length} new message${fresh.length === 1 ? "" : "s"}`;
    setStatus(
      `✓ Exported ${scope}.${copied ? " Copied to clipboard;" : ""} saved a .md to Downloads.`,
      "ok"
    );
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    exportBtn.disabled = false;
  }
});
