// popup.js
//
// Toolbar popup: injects pageExport() into the active ChatGPT tab and delivers
// the whole conversation as Markdown — to the clipboard or to ~/Downloads via
// the native handler. "Download Files" instead snapshots into a folder
// (conversation.md + files/), the native side fetching each image/attachment.
// Web-search citations always become footnotes. Safari exposes the promise-based
// `browser.*` namespace.

const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const filesToggle = document.getElementById("files");
const progressEl = document.getElementById("progress");

const NATIVE_APP = "com.drobnik.chatgptexporter";

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

// Whole-conversation snapshot into ~/Downloads/<Title-ts>/: conversation.md + files/.
async function exportFolder(result) {
  const folder = `${safeName(result.title)}-${timestamp()}`;
  try {
    await saveViaNative("conversation.md", buildMarkdown(result), folder);
  } catch (e) {
    setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
    return;
  }

  const files = result.files || [];
  let ok = 0;
  let failed = 0;
  if (files.length) {
    showProgress(files.length);
    for (let i = 0; i < files.length; i++) {
      try {
        await downloadViaNative(files[i].url, `files/${files[i].name}`, folder, result.token);
        ok++;
      } catch (e) {
        failed++;
      }
      setProgress(i + 1);
    }
    hideProgress();
  }

  const note = files.length
    ? `, ${ok}/${files.length} file${files.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`
    : ", no files";
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

    const withFiles = mode === "download" && !raw && filesToggle.checked;
    const footnotes = !raw; // citations -> footnotes always (except raw JSON)

    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
        args: [raw, withFiles, footnotes],
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

    // ⌥: raw conversation JSON — copy or save depending on the button.
    if (raw) {
      const content = result.raw || "{}";
      const kb = Math.round(content.length / 1024);
      if (mode === "copy") {
        try {
          await navigator.clipboard.writeText(content);
        } catch (e) {
          setStatus("Copy failed: " + (e && e.message ? e.message : e), "err");
          return;
        }
        setStatus(`✓ Copied raw JSON (${kb} KB) to the clipboard.`, "ok");
      } else {
        const path = await saveViaNative(`${safeName(result.title)}-${timestamp()}-raw.json`, content);
        setStatus(`✓ Saved raw JSON (${kb} KB) to ${path.split("/").pop()}.`, "ok");
      }
      return;
    }

    // Download Files: whole-conversation folder snapshot.
    if (withFiles) {
      await exportFolder(result);
      return;
    }

    // Default: the whole chat as Markdown, to the clipboard or a single .md.
    const md = buildMarkdown(result);
    if (mode === "copy") {
      try {
        await navigator.clipboard.writeText(md);
      } catch (e) {
        setStatus("Copy failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      setStatus("✓ Copied the chat to the clipboard.", "ok");
    } else {
      let path;
      try {
        path = await saveViaNative(`${safeName(result.title)}-${timestamp()}.md`, md);
      } catch (e) {
        setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
        return;
      }
      setStatus(`✓ Saved ${path.split("/").pop()} to Downloads.`, "ok");
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

// Holding Option (Alt) switches both buttons to the raw-JSON variant.
function setAltLabels(alt) {
  downloadBtn.textContent = alt ? "Download JSON" : "Download";
  copyBtn.textContent = alt ? "Copy JSON" : "Copy";
}
const syncAlt = (e) => setAltLabels(e.altKey);
window.addEventListener("keydown", syncAlt);
window.addEventListener("keyup", syncAlt);
window.addEventListener("blur", () => setAltLabels(false));
