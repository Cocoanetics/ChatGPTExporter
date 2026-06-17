// popup.js
//
// Toolbar popup UI. Copy runs here — it needs the popup's clipboard and is quick
// (no files). Download is delegated to the background service worker over a port
// so a long file export keeps running even if the popup loses focus and closes:
// progress streams back while the popup is open, and the worker posts a
// notification on completion if it isn't. Markdown assembly + native IPC live in
// export-core.js (shared with the worker). Safari exposes promise-based browser.*.

const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const filesToggle = document.getElementById("files");
const progressEl = document.getElementById("progress");

const CHATGPT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;
const errMsg = (e) => (e && e.message ? e.message : String(e));

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}
function setBusy(busy) {
  downloadBtn.disabled = busy;
  copyBtn.disabled = busy;
}
// Render the bar at value/max, hiding it once complete. Never resets to 0, so
// streaming updates don't make it flicker, and a replayed mid-export value
// (after re-attach) lands at the right spot.
function renderProgress(value, max) {
  progressEl.max = max;
  progressEl.value = value;
  progressEl.classList.toggle("hidden", value >= max);
}
function hideProgress() {
  progressEl.classList.add("hidden");
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Resolve the active tab only if it's a ChatGPT conversation; else null.
async function chatGPTTab() {
  const tab = await getActiveTab();
  if (tab && tab.url && !CHATGPT_URL.test(tab.url)) return null;
  return tab;
}

// Copy: export in-page and put the result on the clipboard. Stays in the popup
// because clipboard access needs its document; it's quick, so there's no
// popup-lifecycle risk to delegate away.
async function runCopy(raw) {
  setBusy(true);
  setStatus("Copying" + (raw ? " raw JSON" : "") + "…");
  try {
    const tab = await chatGPTTab();
    if (!tab) {
      setStatus("Open this on a ChatGPT conversation tab first.", "err");
      return;
    }
    let injection;
    try {
      [injection] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: pageExport,
        args: [raw, false, !raw],
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
    if (raw) {
      const content = result.raw || "{}";
      const kb = Math.round(content.length / 1024);
      await navigator.clipboard.writeText(content);
      setStatus(`✓ Copied raw JSON (${kb} KB) to the clipboard.`, "ok");
    } else {
      await navigator.clipboard.writeText(buildMarkdown(result));
      setStatus("✓ Copied the chat to the clipboard.", "ok");
    }
  } catch (e) {
    setStatus("Copy failed: " + errMsg(e), "err");
  } finally {
    setBusy(false);
  }
}

// Reflect a worker update in the UI. Fires while the popup is open, and also as
// replayed state right after the popup re-attaches to an in-flight export — so
// status/progress mark the popup busy (disabling the buttons) until done/error.
function renderUpdate(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "status":
      setBusy(true);
      setStatus(msg.text);
      break;
    case "progress":
      setBusy(true);
      renderProgress(msg.value, msg.max);
      break;
    case "done":
      hideProgress();
      setStatus(msg.text, "ok");
      setBusy(false);
      break;
    case "error":
      hideProgress();
      setStatus(msg.text, "err");
      setBusy(false);
      break;
  }
}

// Download: hand the job to the background worker so it outlives this popup. We
// reflect its progress while open; if the popup closes the worker finishes on
// its own and posts a notification.
async function startDownload(raw) {
  setBusy(true);
  setStatus("Exporting" + (raw ? " raw JSON" : "") + "…");
  let tab;
  try {
    tab = await chatGPTTab();
  } catch (e) {
    setStatus("Error: " + errMsg(e), "err");
    setBusy(false);
    return;
  }
  if (!tab) {
    setStatus("Open this on a ChatGPT conversation tab first.", "err");
    setBusy(false);
    return;
  }
  const withFiles = !raw && filesToggle.checked;
  // An idle MV3 service worker can drop the on-load port while the popup just
  // sits open, so (re)connect before posting and retry once on a stale-port throw
  // — otherwise the start never reaches the worker and the popup hangs on "Exporting…".
  const start = { type: "start", tabId: tab.id, raw, withFiles };
  try {
    ensurePort().postMessage(start);
  } catch (e) {
    connectWorker().postMessage(start);
  }
}

// Worker connection, opened on load so a reopened popup can re-attach to an
// export already in flight (the worker replays the current state on connect).
// Because an idle service worker may drop the port while the popup sits open,
// connectWorker() is reused via ensurePort() to refresh it before each start.
// Copy doesn't use it.
let workerPort = null;
function connectWorker() {
  const p = browser.runtime.connect({ name: "export" });
  p.onMessage.addListener(renderUpdate);
  p.onDisconnect.addListener(() => {
    if (workerPort === p) workerPort = null;
  });
  workerPort = p;
  return p;
}
function ensurePort() {
  return workerPort || connectWorker();
}
connectWorker();

downloadBtn.addEventListener("click", (e) => startDownload(e.altKey));
copyBtn.addEventListener("click", (e) => runCopy(e.altKey));

// Holding Option (Alt) switches both buttons to the raw-JSON variant.
function setAltLabels(alt) {
  downloadBtn.textContent = alt ? "Download JSON" : "Download";
  copyBtn.textContent = alt ? "Copy JSON" : "Copy";
}
const syncAlt = (e) => setAltLabels(e.altKey);
window.addEventListener("keydown", syncAlt);
window.addEventListener("keyup", syncAlt);
window.addEventListener("blur", () => setAltLabels(false));
