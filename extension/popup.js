// popup.js
//
// Drives the toolbar popup: injects pageExport() into the active ChatGPT tab,
// diffs the returned turns against this conversation's watermark in extension
// storage, and delivers the new Markdown either as a file in ~/Downloads (via
// the native handler) or onto the clipboard. Safari exposes the promise-based
// `browser.*` namespace.

const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const fullToggle = document.getElementById("full");
const debugToggle = document.getElementById("debug");

const storeKey = (convId) => `wikiExport:${convId}`;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

function setBusy(busy) {
  downloadBtn.disabled = busy;
  copyBtn.disabled = busy;
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Hand the file to the native app extension (SafariWebExtensionHandler), which
// writes it straight to ~/Downloads with the exact filename — no browser
// download, so no prompt, no "Unknown" name, no inline preview. Returns the
// absolute path the native side wrote.
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

// Shared pipeline for both actions. `mode` is "download" or "copy" — the only
// difference is where the rendered content goes. Debug mode swaps the content
// for the raw conversation JSON and leaves the watermark untouched.
async function runExport(mode) {
  setBusy(true);
  setStatus(mode === "download" ? "Exporting…" : "Copying…");

  try {
    const tab = await getActiveTab();
    if (tab && tab.url && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
      setStatus("Open this on a ChatGPT conversation tab first.", "err");
      return;
    }

    const debug = debugToggle.checked;

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

    // Decide what to deliver and whether to advance the watermark.
    let content, filename, label;
    let advance = null;
    if (debug) {
      content = result.raw || "{}";
      filename = `${safeName(result.title)}-${timestamp()}-raw.json`;
      label = `raw JSON (${Math.round(content.length / 1024)} KB)`;
    } else {
      const key = storeKey(result.convId);
      const stored = fullToggle.checked ? null : (await browser.storage.local.get(key))[key];
      const seen = new Set((stored && stored.exported) || []);
      const firstRun = seen.size === 0;

      const fresh = result.turns.filter((t) => !seen.has(t.id));
      if (fresh.length === 0) {
        setStatus("✓ Up to date — no new messages since the last pull.", "ok");
        return;
      }

      let md = fresh.map((t) => t.md).join("\n");
      if (firstRun) md = `# ${result.title}\n\n${md}`; // title only on the first pull
      content = md;
      filename = `${safeName(result.title)}-${timestamp()}.md`;
      label = firstRun ? "the whole chat" : `${fresh.length} new message${fresh.length === 1 ? "" : "s"}`;
      advance = { key, ids: Array.from(new Set([...seen, ...fresh.map((t) => t.id)])) };
    }

    // Deliver, then advance the watermark only on a successful delivery.
    if (mode === "copy") {
      try {
        await navigator.clipboard.writeText(content);
      } catch (e) {
        setStatus("Copy failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      if (advance) {
        await browser.storage.local.set({ [advance.key]: { exported: advance.ids, updated: Date.now() } });
      }
      setStatus(`✓ Copied ${label} to the clipboard.`, "ok");
    } else {
      let path;
      try {
        path = await saveViaNative(filename, content);
      } catch (e) {
        setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      if (advance) {
        await browser.storage.local.set({ [advance.key]: { exported: advance.ids, updated: Date.now() } });
      }
      setStatus(`✓ Saved ${label} → ${path.split("/").pop()} in Downloads.`, "ok");
    }
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    setBusy(false);
  }
}

downloadBtn.addEventListener("click", () => runExport("download"));
copyBtn.addEventListener("click", () => runExport("copy"));
