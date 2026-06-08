// popup.js
//
// Drives the toolbar popup: injects pageExport() into the active ChatGPT tab,
// diffs the returned turns against this conversation's watermark in extension
// storage, and emits only the new Markdown (downloaded as a .md file and copied
// to the clipboard). Safari exposes the promise-based `browser.*` namespace.

const statusEl = document.getElementById("status");
const exportBtn = document.getElementById("export");
const fullToggle = document.getElementById("full");

const storeKey = (convId) => `wikiExport:${convId}`;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Save text as a .md file by clicking a transient anchor in the popup document.
// Reliable across Safari versions and needs no `downloads` permission.
function downloadMarkdown(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
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

    // Run the exporter inside the page (carries the session cookies).
    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
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

    downloadMarkdown(`${safeName(result.title)}-${timestamp()}.md`, markdown);
    let copied = true;
    try {
      await navigator.clipboard.writeText(markdown);
    } catch (e) {
      copied = false;
    }

    // Advance the watermark.
    const merged = Array.from(new Set([...seen, ...fresh.map((t) => t.id)]));
    await browser.storage.local.set({ [key]: { exported: merged, updated: Date.now() } });

    const scope = firstRun ? "whole chat" : `${fresh.length} new message${fresh.length === 1 ? "" : "s"}`;
    setStatus(`✓ Exported ${scope}. Saved as .md${copied ? " and copied to clipboard" : ""}.`, "ok");
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    exportBtn.disabled = false;
  }
});
