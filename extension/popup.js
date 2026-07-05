// popup.js
//
// Toolbar popup UI. Copy runs here — it needs the popup's clipboard and is quick
// (no files). Download is delegated to the background service worker over a port
// so a long file export keeps running even if the popup loses focus and closes:
// progress streams back while the popup is open, and the worker posts a
// notification on completion if it isn't. Markdown assembly + native IPC live in
// export-core.js (shared with the worker). Safari exposes promise-based browser.*.
//
// Port messages are only the fast path. Safari can silently swallow a post on a
// stale port and can suspend the worker mid-export, so while busy the popup
// also polls the worker's journal (jobStore in export-core.js) as ground truth:
// a journaled job proves the start arrived, a lastResult proves it ended, and a
// stale heartbeat proves the worker died. Every busy state therefore has an
// exit — a lost message can no longer freeze the popup on "Exporting…".

const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const copyBtn = document.getElementById("copy");
const filesToggle = document.getElementById("files");
const progressEl = document.getElementById("progress");

const CHATGPT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;
const errMsg = (e) => (e && e.message ? e.message : String(e));

const POLL_MS = 2000; // journal poll cadence while busy
const START_GRACE_MS = 4000; // silence after "start" before we declare the worker unreachable
const RESULT_TTL_MS = 10 * 60 * 1000; // show a recent result on open instead of the idle hint

let exportBusy = false; // a background export is running (or believed to be)
let busySince = 0; // when this popup entered the busy state
let startWatchdog = null; // armed on "start": no ack/status/journal ⇒ unfreeze with an error
let pollTimer = null; // journal poll while busy

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.className = kind;
}
function setBusy(busy) {
  downloadBtn.disabled = busy;
  copyBtn.disabled = busy;
  // Toggling mid-export wouldn't affect the running job, so don't pretend it would.
  filesToggle.disabled = busy;
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

// Enter/leave the export-busy state. All terminal paths go through leaveBusy so
// the buttons can never stay disabled after the export is over (or dead).
function enterBusy() {
  clearTimeout(startWatchdog);
  startWatchdog = null;
  if (!exportBusy) {
    exportBusy = true;
    busySince = Date.now();
  }
  setBusy(true);
  startPolling();
}
function leaveBusy(text, kind) {
  exportBusy = false;
  clearTimeout(startWatchdog);
  startWatchdog = null;
  stopPolling();
  hideProgress();
  setStatus(text, kind);
  setBusy(false);
}

// Tell the worker the terminal state was seen, so it skips the notification.
function ackResult() {
  try {
    ensurePort().postMessage({ type: "done-ack" });
  } catch (e) {
    /* worker gone — its notification fallback handles itself */
  }
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
    // Don't clobber a replayed export-busy state (a download can be running in
    // the background while this popup was merely copying).
    setBusy(exportBusy);
  }
}

// Reflect a worker update in the UI. Fires while the popup is open, and also as
// replayed state right after the popup re-attaches to an in-flight export — so
// status/progress mark the popup busy (disabling the buttons) until done/error.
function renderUpdate(msg) {
  if (!msg) return;
  switch (msg.type) {
    case "ack": // worker took the job; status/progress follow
      clearTimeout(startWatchdog);
      startWatchdog = null;
      enterBusy();
      break;
    case "status":
      enterBusy();
      setStatus(msg.text);
      break;
    case "progress":
      enterBusy();
      renderProgress(msg.value, msg.max);
      break;
    case "done":
      ackResult();
      leaveBusy(msg.text, "ok");
      break;
    case "error":
      ackResult();
      leaveBusy(msg.text, "err");
      break;
  }
}

// While busy, poll the journal as ground truth; port messages just arrive
// faster. Each poll sees one of three states: job running (render it), job
// ended (render its result), or job dead/vanished (worker died — unfreeze).
function startPolling() {
  if (!pollTimer) pollTimer = setInterval(pollJournal, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}
async function pollJournal() {
  const j = await jobStore.get("job");
  if (!exportBusy) return; // a port message resolved things while we awaited
  if (j) {
    if (Date.now() - (j.lastUpdateAt || j.startedAt) > JOB_STALE_MS) {
      // Heartbeat went stale: the worker died mid-export and nothing will
      // finish this job. Clear it so reconcile()/we don't report it twice.
      jobStore.remove("job");
      leaveBusy("The export was interrupted — check Downloads, then try again.", "err");
      return;
    }
    if (j.status) setStatus(j.status);
    if (j.progress) renderProgress(j.progress.value, j.progress.max);
    return;
  }
  const r = await jobStore.get("lastResult");
  if (!exportBusy) return;
  if (r && r.at >= busySince - POLL_MS) {
    // The job ended but the port message didn't reach us.
    ackResult();
    leaveBusy(r.text, r.ok ? "ok" : "err");
  } else {
    leaveBusy("The export was interrupted — check Downloads, then try again.", "err");
  }
}

// Download: hand the job to the background worker so it outlives this popup. We
// reflect its progress while open; if the popup closes the worker finishes on
// its own and posts a notification.
async function startDownload(raw) {
  setBusy(true);
  setStatus("Starting export" + (raw ? " (raw JSON)" : "") + "…");
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
  // sits open, so (re)connect before posting and retry once on a stale-port
  // throw. Safari can also swallow the post *silently*, so delivery is never
  // assumed: the watchdog below unfreezes the UI unless an ack, an update, or
  // a journal entry proves the start landed.
  const start = { type: "start", tabId: tab.id, raw, withFiles };
  try {
    ensurePort().postMessage(start);
  } catch (e) {
    try {
      connectWorker().postMessage(start);
    } catch (e2) {
      setStatus("Couldn't reach the export worker — please try again.", "err");
      setBusy(false);
      return;
    }
  }
  clearTimeout(startWatchdog);
  startWatchdog = setTimeout(async () => {
    startWatchdog = null;
    const j = await jobStore.get("job");
    if (j) {
      // The start landed; only the port is mute. Poll the journal instead.
      enterBusy();
      if (j.status) setStatus(j.status);
      if (j.progress) renderProgress(j.progress.value, j.progress.max);
    } else if (!exportBusy) {
      setStatus("Couldn't reach the export worker — please try again.", "err");
      setBusy(false);
    }
  }, START_GRACE_MS);
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
    // Mid-export, don't just go quiet: reconnect so a restarted worker can
    // replay its state. The journal poll covers the case where none comes up.
    if (exportBusy) {
      setTimeout(() => {
        if (exportBusy && !workerPort) connectWorker();
      }, 1000);
    }
  });
  workerPort = p;
  return p;
}
function ensurePort() {
  return workerPort || connectWorker();
}
connectWorker();

// A reopened popup may land mid-export (busy view via replay or journal) or
// just after one ended (show the recent result instead of the idle hint).
async function initFromJournal() {
  const j = await jobStore.get("job");
  if (j) {
    enterBusy();
    if (j.status) setStatus(j.status);
    if (j.progress) renderProgress(j.progress.value, j.progress.max);
    return;
  }
  const r = await jobStore.get("lastResult");
  if (r && Date.now() - r.at < RESULT_TTL_MS && !exportBusy) {
    setStatus(r.text, r.ok ? "ok" : "err");
  }
}
initFromJournal();

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
