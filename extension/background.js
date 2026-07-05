// background.js
//
// Service worker that owns the *download* side of the export so it survives the
// popup closing. A Safari popup is a transient WebView — torn down the moment it
// loses focus, killing any in-flight work. So the popup only triggers the export
// (and handles Copy, which needs its own clipboard); everything that writes to
// ~/Downloads runs here instead, reporting progress back over a port while the
// popup is open and falling back to a notification once it's gone. If the popup
// is reopened mid-export it re-attaches and resumes showing live progress.
//
// Safari also suspends *this* worker aggressively — even mid-await — so nothing
// authoritative lives only in memory. The in-flight job is journaled via
// jobStore (export-core.js): every status/progress change and a 15s heartbeat
// update it, finish() replaces it with a lastResult record, and a freshly
// (re)started worker reconciles — an orphaned journal entry means a previous
// instance died mid-export, which gets reported instead of silently dropped.
// A repeating alarm bounds how long such a death can go unnoticed while no
// popup is open. The popup polls the same journal as ground truth, so a lost
// port message can no longer freeze it.
//
// importScripts pulls in pageExport()/pageResolveFiles() (the page-injected
// exporters) and the shared Markdown/native helpers — the same files popup.html
// loads via <script>.

importScripts("exporter.js", "export-core.js");

const errMsg = (e) => (e && e.message ? e.message : String(e));

const HEARTBEAT_MS = 15000; // journal liveness cadence; well under JOB_STALE_MS
const KEEPALIVE_ALARM = "export-watchdog";

function notify(text) {
  try {
    browser.notifications.create({
      type: "basic",
      iconUrl: browser.runtime.getURL("images/icon-128.png"),
      title: "ChatGPT Exporter",
      message: text.replace(/^✓\s*/, ""),
    });
  } catch (e) {
    // notifications unavailable — the files are saved regardless
  }
}

// One in-flight export at a time. `job` is this instance's working copy of the
// journal entry; the journal (jobStore) is the durable truth. `livePort` is
// whichever popup is listening right now, or null when none is open.
let livePort = null;
let job = null; // { id, kind, startedAt, lastUpdateAt, status, progress, folder } while running
let heartbeat = null;
let ackTimer = null; // finish() falls back to a notification unless the popup acks in time

function journalJob() {
  if (job) jobStore.set("job", job);
}

// Send an update to the live popup (if any) and journal it for replay/polling.
function emit(msg) {
  if (job) {
    if (msg.type === "status") job.status = msg.text;
    else if (msg.type === "progress") job.progress = { value: msg.value, max: msg.max };
    job.lastUpdateAt = Date.now();
    journalJob();
  }
  if (livePort) {
    try {
      livePort.postMessage(msg);
    } catch (e) {
      /* popup vanished between the check and the post */
    }
  }
}

// Deliver the terminal result and end the job. The journal entry is swapped for
// a lastResult record *first*, so the outcome survives whatever happens to this
// worker or the popup next. Port delivery is unverifiable — a stale Safari port
// can swallow a post without throwing — so the popup must ack the terminal
// message within a grace period; otherwise the notification fires just as if
// the popup were closed.
async function finish(ok, text) {
  // Await the terminal writes, in commit order: result first, then the job
  // removal. Fire-and-forget here would let a poll observe "no job, no result"
  // (spurious "interrupted" after a real completion), or a suspension right
  // after delivery strand the journal with a stale job entry that the next
  // reconcile() would misreport as an interrupted export.
  await jobStore.set("lastResult", { ok, text, at: Date.now(), jobId: job && job.id });
  await jobStore.remove("job");
  endJob();
  const msg = { type: ok ? "done" : "error", text };
  if (livePort) {
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => notify(text), 1500);
    try {
      livePort.postMessage(msg);
    } catch (e) {
      clearTimeout(ackTimer);
      notify(text);
    }
  } else {
    notify(text);
  }
}

function beginJob({ tabId, raw, withFiles }) {
  job = {
    id: `${tabId}-${Date.now()}`,
    kind: raw ? "raw" : withFiles ? "folder" : "md",
    startedAt: Date.now(),
    lastUpdateAt: Date.now(),
    status: "",
    progress: null,
    folder: null,
  };
  journalJob();
  // The heartbeat keeps the journal provably live — the popup and reconcile()
  // read a stale lastUpdateAt as "the worker died" — and gives Safari periodic
  // extension-API activity during long native awaits.
  heartbeat = setInterval(() => {
    if (job) {
      job.lastUpdateAt = Date.now();
      journalJob();
    }
  }, HEARTBEAT_MS);
  // The alarm outlives this instance: if Safari kills the worker mid-export,
  // the next alarm wakes a fresh one whose reconcile() reports the interrupted
  // job — bounding "silent truncation" to about a minute.
  if (browser.alarms) browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
}

function endJob() {
  job = null;
  clearInterval(heartbeat);
  heartbeat = null;
  if (browser.alarms) browser.alarms.clear(KEEPALIVE_ALARM);
}

// A journal entry with no live job in this instance means a previous worker
// died mid-export: the folder on disk may look complete but isn't. Report it
// and clear the journal so the next export starts clean.
async function reconcile() {
  const stale = await jobStore.get("job");
  if (!stale || job) return; // nothing orphaned, or we're the instance running it
  const p = stale.progress;
  const where = stale.folder ? `Export of "${stale.folder}"` : "The export";
  const text =
    p && p.max
      ? `${where} was interrupted — ${p.value} of ${p.max} files saved. Run it again to get the rest.`
      : `${where} was interrupted before finishing. Please run it again.`;
  // Same commit order as finish(): result before job removal, so a concurrent
  // popup poll never sees the journal empty on both keys.
  await jobStore.set("lastResult", { ok: false, text, at: Date.now(), jobId: stale.id });
  await jobStore.remove("job");
  notify(text);
}
reconcile(); // runs on every worker (re)start

if (browser.alarms) {
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === KEEPALIVE_ALARM) reconcile();
  });
}

const ctx = { report: emit, finish };

// Whole-conversation snapshot into ~/Downloads/<Title-ts>/: conversation.md + files/.
async function exportFolder(result, ctx, tabId) {
  const folder = `${safeName(result.title)}-${timestamp()}`;
  if (job) {
    job.folder = folder; // names the folder in an "interrupted" report
    journalJob();
  }
  try {
    await saveViaNative("conversation.md", buildMarkdown(result), folder);
  } catch (e) {
    return ctx.finish(false, "Save failed: " + errMsg(e));
  }

  const files = result.files || [];
  let ok = 0;
  let failed = 0;
  let done = 0;
  const failures = []; // { f, retryable } — feeds the second-chance pass below
  if (files.length) {
    ctx.report({ type: "progress", value: 0, max: files.length });
    // Fetch concurrently (bounded) rather than one-at-a-time — a few hundred
    // sequential native downloads is the slow half of a big-thread export.
    const POOL = 6;
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        try {
          await downloadViaNative(f.url, `files/${f.name}`, folder, result.token);
          ok++;
        } catch (e) {
          failed++;
          // Only kind:"file" entries can be re-resolved in the page; sandbox
          // URLs are one-shot (the interpreter endpoint already re-signed them).
          failures.push({ f, retryable: !!e.retryable && f.kind === "file" });
        }
        ctx.report({ type: "progress", value: ++done, max: files.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
  }

  // Second chance: pre-signed URLs minted before a long download run can be
  // expired by the time the pool reaches them (401/403), and network blips
  // happen. Re-resolve fresh URLs in the page and retry each such file once.
  const retriable = failures.filter((x) => x.retryable);
  if (retriable.length && tabId != null) {
    ctx.report({
      type: "status",
      text: `Retrying ${retriable.length} failed file${retriable.length === 1 ? "" : "s"}…`,
    });
    let fresh = null;
    try {
      const [inj] = await browser.scripting.executeScript({
        target: { tabId },
        func: pageResolveFiles,
        args: [retriable.map((x) => x.f.fileId)],
      });
      fresh = inj && inj.result;
    } catch (e) {
      /* tab gone — keep the first-pass counts */
    }
    if (fresh && fresh.urls) {
      for (const x of retriable) {
        const url = fresh.urls[x.f.fileId];
        if (!url) continue;
        try {
          await downloadViaNative(url, `files/${x.f.name}`, folder, fresh.token || result.token);
          ok++;
          failed--;
        } catch (e) {
          /* stays failed */
        }
      }
    }
  }

  // Report what actually happened — including files that never even resolved
  // to a URL (result.unresolved), which used to vanish from the count.
  const unresolvedNote = result.unresolved ? `; ${result.unresolved} could not be resolved` : "";
  const note =
    files.length || result.unresolved
      ? `, ${ok}/${files.length} file${files.length === 1 ? "" : "s"}${
          failed ? ` (${failed} failed)` : ""
        }${unresolvedNote}`
      : ", no files";
  const allGood = !failed && !result.unresolved;
  ctx.finish(
    true,
    `${allGood ? "✓ " : ""}Saved ${folder}/ to Downloads — ${result.turns.length} turns${note}.`
  );
}

async function runExport({ tabId, raw, withFiles }, ctx) {
  ctx.report({ type: "status", text: "Exporting" + (raw ? " raw JSON" : "") + "…" });

  let injection;
  try {
    [injection] = await browser.scripting.executeScript({
      target: { tabId },
      func: pageExport,
      args: [raw, withFiles, !raw],
    });
  } catch (e) {
    return ctx.finish(false, "Couldn't reach the page. Open a ChatGPT chat and try again.");
  }

  const result = injection && injection.result;
  if (!result) return ctx.finish(false, "No response from the page.");
  if (result.error) return ctx.finish(false, result.error);

  // ⌥: raw conversation JSON saved as a single file.
  if (raw) {
    const content = result.raw || "{}";
    const kb = Math.round(content.length / 1024);
    try {
      const path = await saveViaNative(`${safeName(result.title)}-${timestamp()}-raw.json`, content);
      return ctx.finish(true, `✓ Saved raw JSON (${kb} KB) to ${path.split("/").pop()}.`);
    } catch (e) {
      return ctx.finish(false, "Save failed: " + errMsg(e));
    }
  }

  // Download Files: whole-conversation folder snapshot.
  if (withFiles) return exportFolder(result, ctx, tabId);

  // Default: the whole chat as a single .md.
  const md = buildMarkdown(result);
  try {
    const path = await saveViaNative(`${safeName(result.title)}-${timestamp()}.md`, md);
    ctx.finish(true, `✓ Saved ${path.split("/").pop()} to Downloads.`);
  } catch (e) {
    ctx.finish(false, "Save failed: " + errMsg(e));
  }
}

// The popup connects a port and posts { type: "start", … }. Progress/status flow
// back over that port while it's open; if the popup closes mid-export the port
// disconnects but the job keeps running, and the final result arrives as a
// notification instead. A "start" is acked immediately (the popup's watchdog
// treats silence as a dead worker), and a duplicate start gets the running
// job's state back rather than being silently swallowed.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;
  livePort = port;

  // Re-attach: if an export is already running, replay its current state so the
  // reopened popup resumes showing progress instead of the idle UI.
  if (job) {
    if (job.status) {
      try {
        port.postMessage({ type: "status", text: job.status });
      } catch (e) {}
    }
    if (job.progress) {
      try {
        port.postMessage({ type: "progress", value: job.progress.value, max: job.progress.max });
      } catch (e) {}
    }
  }

  port.onDisconnect.addListener(() => {
    if (livePort === port) livePort = null;
  });

  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "done-ack") {
      // The popup rendered the terminal state — no notification needed.
      clearTimeout(ackTimer);
      ackTimer = null;
      return;
    }
    if (msg.type === "start") {
      if (job) {
        // One export at a time — answer with what's already running instead of
        // leaving the clicker staring at an unacknowledged "Starting…".
        try {
          port.postMessage({ type: "status", text: job.status || "Exporting…" });
          if (job.progress) {
            port.postMessage({ type: "progress", value: job.progress.value, max: job.progress.max });
          }
        } catch (e) {}
        return;
      }
      beginJob(msg);
      try {
        port.postMessage({ type: "ack", jobId: job.id });
      } catch (e) {
        /* popup will find the journal via its watchdog */
      }
      runExport(msg, ctx).catch((e) => finish(false, "Error: " + errMsg(e)));
    }
  });
});
