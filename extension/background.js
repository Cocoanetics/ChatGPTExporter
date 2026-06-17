// background.js
//
// Service worker that owns the *download* side of the export so it survives the
// popup closing. A Safari popup is a transient WebView — torn down the moment it
// loses focus, killing any in-flight work. So the popup only triggers the export
// (and handles Copy, which needs its own clipboard); everything that writes to
// ~/Downloads runs here instead, reporting progress back over a port while the
// popup is open and falling back to a notification once it's gone.
//
// importScripts pulls in pageExport() (the page-injected exporter) and the
// shared Markdown/native helpers — the same files popup.html loads via <script>.

importScripts("exporter.js", "export-core.js");

const errMsg = (e) => (e && e.message ? e.message : String(e));

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

// Whole-conversation snapshot into ~/Downloads/<Title-ts>/: conversation.md + files/.
async function exportFolder(result, ctx) {
  const folder = `${safeName(result.title)}-${timestamp()}`;
  try {
    await saveViaNative("conversation.md", buildMarkdown(result), folder);
  } catch (e) {
    return ctx.finish(false, "Save failed: " + errMsg(e));
  }

  const files = result.files || [];
  let ok = 0;
  let failed = 0;
  let done = 0;
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
        }
        ctx.report({ type: "progress", value: ++done, max: files.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(POOL, files.length) }, worker));
  }

  const note = files.length
    ? `, ${ok}/${files.length} file${files.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}`
    : ", no files";
  ctx.finish(true, `✓ Saved ${folder}/ to Downloads — ${result.turns.length} turns${note}.`);
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
  if (withFiles) return exportFolder(result, ctx);

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
// notification instead.
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;
  let alive = true;
  port.onDisconnect.addListener(() => {
    alive = false;
  });
  const ctx = {
    report(msg) {
      if (!alive) return;
      try {
        port.postMessage(msg);
      } catch (e) {
        /* popup went away between the check and the post */
      }
    },
    finish(ok, text) {
      if (alive) {
        try {
          port.postMessage({ type: ok ? "done" : "error", text });
          return;
        } catch (e) {
          /* fall through to notification */
        }
      }
      notify(text);
    },
  };
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "start") {
      runExport(msg, ctx).catch((e) => ctx.finish(false, "Error: " + errMsg(e)));
    }
  });
});
