// popup.js
//
// Drives the toolbar popup: injects pageExport() into the active ChatGPT tab,
// diffs the returned turns against this conversation's watermark, and delivers
// the new Markdown to the clipboard or to ~/Downloads via the native handler.
// "Download images" instead snapshots the whole conversation into a folder
// (conversation.md + images/), the native side fetching each picture (no CORS).
// Safari exposes the promise-based `browser.*` namespace.

const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const fullToggle = document.getElementById("full");
const imagesToggle = document.getElementById("images");
const progressEl = document.getElementById("progress");

const NATIVE_APP = "com.drobnik.chatgptexporter";
const storeKey = (convId) => `wikiExport:${convId}`;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}
function setBusy(busy) {
  downloadBtn.disabled = busy;
  copyBtn.disabled = busy;
}
function showProgress(max) {
  progressEl.max = max;
  progressEl.value = 0;
  progressEl.classList.remove("hidden");
}
function setProgress(value) {
  progressEl.value = value;
}
function hideProgress() {
  progressEl.classList.add("hidden");
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Native handler writes a UTF-8 text file to ~/Downloads/[dir/]filename and
// returns its absolute path — no browser download, so no prompt or "Unknown".
async function saveViaNative(filename, text, dir) {
  const resp = await browser.runtime.sendNativeMessage(NATIVE_APP, { action: "save", filename, text, dir });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "native save failed");
  return resp.path;
}

// Native handler downloads `url` (no CORS, unlike a content-script fetch) and
// writes it to ~/Downloads/[dir/]filename.
async function downloadViaNative(url, filename, dir, token) {
  const resp = await browser.runtime.sendNativeMessage(NATIVE_APP, { action: "download", url, filename, dir, token });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || "image download failed");
  return resp.path;
}

function timestamp() {
  return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
}
function safeName(title) {
  return title.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 80) || "chatgpt";
}

// Whole-conversation snapshot into ~/Downloads/<Title-ts>/: conversation.md plus
// an images/ folder. Not incremental and leaves the watermark untouched.
async function exportFolder(result) {
  const folder = `${safeName(result.title)}-${timestamp()}`;
  const md = `# ${result.title}\n\n` + result.turns.map((t) => t.md).join("\n");

  try {
    await saveViaNative("conversation.md", md, folder);
  } catch (e) {
    setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
    return;
  }

  const images = result.images || [];
  let ok = 0;
  let failed = 0;
  if (images.length) {
    showProgress(images.length);
    for (let i = 0; i < images.length; i++) {
      try {
        await downloadViaNative(images[i].url, `images/${images[i].name}`, folder, result.token);
        ok++;
      } catch (e) {
        failed++;
      }
      setProgress(i + 1);
    }
    hideProgress();
  }

  const note = images.length
    ? `, ${ok}/${images.length} image${images.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`
    : ", no images";
  setStatus(`✓ Saved ${folder}/ to Downloads — ${result.turns.length} turns${note}.`, "ok");
}

async function runExport(mode, raw) {
  setBusy(true);
  setStatus((mode === "download" ? "Exporting" : "Copying") + (raw ? " raw JSON" : "") + "…");

  try {
    const tab = await getActiveTab();
    if (tab && tab.url && !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
      setStatus("Open this on a ChatGPT conversation tab first.", "err");
      return;
    }

    const withImages = mode === "download" && !raw && imagesToggle.checked;

    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
        args: [raw, withImages],
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

    // ⌥: raw conversation JSON to a single file (ignores the watermark).
    if (raw) {
      const content = result.raw || "{}";
      const path = await saveViaNative(`${safeName(result.title)}-${timestamp()}-raw.json`, content);
      setStatus(`✓ Saved raw JSON (${Math.round(content.length / 1024)} KB) to ${path.split("/").pop()}.`, "ok");
      return;
    }

    // "Download images": whole-conversation folder snapshot (ignores the watermark).
    if (withImages) {
      await exportFolder(result);
      return;
    }

    // Default: incremental Markdown to the clipboard or a single .md.
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
    if (firstRun) md = `# ${result.title}\n\n${md}`;
    const label = firstRun ? "the whole chat" : `${fresh.length} new message${fresh.length === 1 ? "" : "s"}`;
    const advanceIds = Array.from(new Set([...seen, ...fresh.map((t) => t.id)]));

    if (mode === "copy") {
      try {
        await navigator.clipboard.writeText(md);
      } catch (e) {
        setStatus("Copy failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      await browser.storage.local.set({ [key]: { exported: advanceIds, updated: Date.now() } });
      setStatus(`✓ Copied ${label} to the clipboard.`, "ok");
    } else {
      let path;
      try {
        path = await saveViaNative(`${safeName(result.title)}-${timestamp()}.md`, md);
      } catch (e) {
        setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      await browser.storage.local.set({ [key]: { exported: advanceIds, updated: Date.now() } });
      setStatus(`✓ Saved ${label} → ${path.split("/").pop()} in Downloads.`, "ok");
    }
  } catch (e) {
    setStatus("Error: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    hideProgress();
    setBusy(false);
  }
}

downloadBtn.addEventListener("click", (e) => runExport("download", e.altKey));
copyBtn.addEventListener("click", (e) => runExport("copy", e.altKey));

// Holding Option (Alt) switches both buttons to the raw-JSON variant, with a
// live label. The handlers read e.altKey, so behavior is right even if the popup
// opened with Option already held.
function setAltLabels(alt) {
  downloadBtn.textContent = alt ? "Download JSON" : "Download .md";
  copyBtn.textContent = alt ? "Copy JSON" : "Copy";
}
const syncAlt = (e) => setAltLabels(e.altKey);
window.addEventListener("keydown", syncAlt);
window.addEventListener("keyup", syncAlt);
window.addEventListener("blur", () => setAltLabels(false));
