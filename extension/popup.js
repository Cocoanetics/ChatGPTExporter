// popup.js
//
// Drives the toolbar popup: injects pageExport() into the active ChatGPT tab,
// diffs the returned turns against this conversation's watermark in extension
// storage, and emits only the new Markdown — copied to the clipboard and written
// to ~/Downloads by the native handler. Safari exposes the promise-based
// `browser.*` namespace.

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

// Hand the file to the native app extension (SafariWebExtensionHandler), which
// writes it straight to ~/Downloads with the exact filename. This sidesteps
// Safari's whole download path — no "allow downloads" prompt, no "Unknown"
// filename, no inline preview — because no browser download happens at all.
// Returns the absolute path the native side wrote.
async function saveViaNative(filename, text) {
  const resp = await browser.runtime.sendNativeMessage("com.drobnik.chatgptexporter", {
    action: "save",
    filename,
    text,
  });
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || "native save failed");
  }
  return resp.path;
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
      const path = await saveViaNative(`${safeName(result.title)}-${timestamp()}-raw.json`, result.raw || "{}");
      setStatus(
        `✓ Saved raw JSON (${Math.round((result.raw || "").length / 1024)} KB) to ${path.split("/").pop()}. Tune cleanup, then re-run with Debug off.`,
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
    let savedPath;
    try {
      savedPath = await saveViaNative(`${safeName(result.title)}-${timestamp()}.md`, markdown);
    } catch (e) {
      // Leave the watermark untouched so the next run re-offers these turns.
      setStatus(
        `Save failed: ${e.message}.${copied ? " The Markdown is on your clipboard." : ""}`,
        "err"
      );
      return;
    }

    // Advance the watermark only after a successful save.
    const merged = Array.from(new Set([...seen, ...fresh.map((t) => t.id)]));
    await browser.storage.local.set({ [key]: { exported: merged, updated: Date.now() } });

    const scope = firstRun ? "the whole chat" : `${fresh.length} new message${fresh.length === 1 ? "" : "s"}`;
    setStatus(
      `✓ Exported ${scope}.${copied ? " Copied to clipboard;" : ""} saved ${savedPath.split("/").pop()} to Downloads.`,
      "ok"
    );
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    exportBtn.disabled = false;
  }
});
