// exporter.js
//
// `pageExport` runs INSIDE the chatgpt.com page (injected by popup.js via
// browser.scripting.executeScript). Because it executes in the page's origin,
// its same-origin fetches carry the logged-in session cookies — so it can read
// /api/auth/session, /backend-api/conversation/{id}, and the file download
// endpoints exactly like the page itself.
//
// It must be fully self-contained: executeScript serializes this function's
// source and runs it in the page, so it cannot reference anything in the
// popup's scope. It returns a plain (structurally cloneable) object.
//
// Returned shape:
//   { convId, title, turns: [{ id, role, md }], files?, footnotes?, token?, raw? }
//   { error: "..." }   on failure
//
// `raw` (Option-click) attaches the full conversation JSON. `withFiles` resolves
// every image and attachment (PDFs, …) to a pre-signed URL, returns them as
// `files: [{ fileId, url, name }]`, and rewrites placeholders to files/<name>
// links. Canvas documents need no server round-trip (their content already
// sits in the conversation JSON), so those entries carry `{ fileId, name,
// content }` instead of a `url` — the caller must branch on which is present.
// `footnotes` converts web-search citations to GFM footnotes.

async function pageExport(raw, withFiles, footnotes) {
  // Two concurrent runs (a re-click racing a restarted worker) would race the
  // same files/ destinations — refuse the second instead.
  if (window.__chatgptExporterBusy) {
    return { error: "An export of this chat is already running." };
  }
  window.__chatgptExporterBusy = true;
  try {
    return await run();
  } finally {
    window.__chatgptExporterBusy = false;
  }

  async function run() {
  const convId = location.pathname.split("/").filter(Boolean).pop();
  if (!convId) {
    return { error: "No conversation is open. Open a chat first, then export." };
  }
  // Conversation URLs end in a UUID (chatgpt.com/c/<uuid>, /g/<gizmo>/c/<uuid>).
  // On other chatgpt.com pages (library, settings, a fresh chat) the last path
  // segment is a word like "library" — catch that here instead of surfacing a
  // confusing "Failed to fetch conversation (HTTP 404)" later.
  if (!/^[0-9a-f-]{20,}$/i.test(convId)) {
    return { error: "This page isn't a conversation. Open a chat first, then export." };
  }

  // Every fetch gets a deadline — fetch() has none, and a single stalled
  // request would otherwise hang the export (and the single-job guard with it)
  // forever. The abort timer stays armed until `use(response)` finishes — body
  // reads included — so a stall *during* r.json() is aborted too.
  const withDeadline = async (url, opts, ms, use) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
      return await use(r);
    } finally {
      clearTimeout(timer);
    }
  };

  let accessToken;
  try {
    const session = await withDeadline("/api/auth/session", null, 15000, (r) => {
      // A transient server error must not masquerade as "logged out".
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    accessToken = session && session.accessToken;
  } catch (e) {
    return { error: "Could not read the ChatGPT session (" + e.message + "). Try again." };
  }
  if (!accessToken) {
    return { error: "Not logged in to ChatGPT (no access token)." };
  }

  let convo;
  try {
    convo = await withDeadline(
      `/backend-api/conversation/${convId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      60000,
      (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      }
    );
  } catch (e) {
    return { error: "Failed to fetch the conversation: " + e.message };
  }

  // Active path: current_node -> parent -> ... -> root, reversed.
  const path = [];
  for (let id = convo.current_node; id; ) {
    const node = convo.mapping[id];
    if (!node) break;
    if (node.message) path.push({ id, msg: node.message });
    id = node.parent;
  }
  path.reverse();

  // Web-search citations are wrapped in private-use delimiters, e.g.
  // <U+E200>cite<U+E202>turn0search1<U+E202>…<U+E201>. Build the regex from char
  // codes so the source stays plain ASCII. Also strip the older 【…】 form.
  const CITE_TOKEN = new RegExp(
    String.fromCharCode(0xe200) + "[\\s\\S]*?" + String.fromCharCode(0xe201),
    "g"
  );
  const stripCitations = (s) => s.replace(CITE_TOKEN, "").replace(/【[^】]*】/g, "");
  const stripDirectives = (s) =>
    s.replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "").replace(/^[ \t]*:::[ \t]*$/gm, "");

  const fileIdOf = (ptr) => {
    const s = typeof ptr === "string" ? ptr : "";
    const m = s.match(/^(?:file-service|sediment):\/\/(.+)$/);
    return m ? m[1] : s || null;
  };
  const isImagePart = (p) => p && p.content_type === "image_asset_pointer";
  const hasImage = (m) => ((m.content && m.content.parts) || []).some(isImagePart);

  // Document-wide footnote registry (dedupe web-search sources by URL).
  const notes = [];
  const noteByUrl = new Map();
  const noteNum = (url, title) => {
    if (!noteByUrl.has(url)) {
      notes.push({ num: notes.length + 1, title: title || url, url });
      noteByUrl.set(url, notes.length);
    }
    return noteByUrl.get(url);
  };

  const pendingFiles = [];
  const attMeta = {}; // fileId -> { name, mime }
  const sandboxFiles = []; // code-interpreter files: { url, name }
  const sandboxByPath = {}; // sandbox path -> local filename

  // Canvas ("canmore" tool) documents: ChatGPT's side-panel editor. The doc is
  // created via a hidden assistant call (recipient "canmore.create_textdoc",
  // content_type "code", a JSON payload with the full text) and edited via
  // "canmore.update_textdoc" calls (regex pattern/replacement patches). Both
  // calls are recipient-filtered out of the visible turns below, and the
  // content never appears in message text at all — unlike the file-cref case
  // above, there's no placeholder token to substitute, so the only way to
  // notice a canvas doc exists is the turn_exchange_id it shares with the
  // tool's confirmation message, which carries the canonical (non-obfuscated)
  // { textdoc_id, title } in metadata.canvas.
  const canvasByExchange = {}; // turn_exchange_id -> { textdocId, title }
  const canvasDocs = {}; // textdocId -> { title, content }
  {
    let pendingPayload = null;
    for (const { msg } of path) {
      const recipient = msg.recipient || "";
      if (msg.author && msg.author.role === "assistant" && /^canmore\.(create|update)_textdoc$/.test(recipient)) {
        const c = msg.content || {};
        try {
          pendingPayload = c.content_type === "code" && typeof c.text === "string" ? JSON.parse(c.text) : null;
        } catch (e) {
          pendingPayload = null;
        }
        continue;
      }
      const canvas = msg.metadata && msg.metadata.canvas;
      if (msg.author && msg.author.role === "tool" && canvas && canvas.textdoc_id) {
        const exch = msg.metadata.turn_exchange_id;
        if (exch) canvasByExchange[exch] = { textdocId: canvas.textdoc_id, title: canvas.title };
        if (pendingPayload) {
          const existing = canvasDocs[canvas.textdoc_id];
          if (typeof pendingPayload.content === "string") {
            canvasDocs[canvas.textdoc_id] = { title: canvas.title || pendingPayload.name, content: pendingPayload.content };
          } else if (Array.isArray(pendingPayload.updates) && existing) {
            let content = existing.content;
            for (const u of pendingPayload.updates) {
              if (!u || typeof u.pattern !== "string" || typeof u.replacement !== "string") continue;
              try {
                content = content.replace(new RegExp(u.pattern, u.multiple ? "g" : ""), u.replacement);
              } catch (e) {
                // model emitted an invalid regex — leave this one patch unapplied
              }
            }
            canvasDocs[canvas.textdoc_id] = { title: canvas.title || existing.title, content };
          }
        }
        pendingPayload = null;
      }
    }
  }
  const canvasFileIds = new Set();
  const canvasMark = (m) => {
    const exch = m.metadata && m.metadata.turn_exchange_id;
    const ref = exch && canvasByExchange[exch];
    const doc = ref && canvasDocs[ref.textdocId];
    if (!doc) return "";
    if (!withFiles) return `\n\n_[canvas document "${doc.title}" omitted]_`;
    canvasFileIds.add(ref.textdocId);
    return `\n\n@@FILE@@canvas:${ref.textdocId}@@`;
  };

  // Code-interpreter files are linked as [text](sandbox:/mnt/data/<name>). The
  // live interpreter/download endpoint serves them (bearer-authenticated, like
  // image files); the sandbox is ephemeral, so old chats may 404.
  const usedSandboxNames = new Set();
  const collectSandbox = (text, msgId) => {
    for (const mm of text.matchAll(/sandbox:(\/[^\s)]+)/g)) {
      const sandboxPath = mm[1];
      if (sandboxByPath[sandboxPath]) continue;
      let name = (sandboxPath.split("/").pop() || "file").replace(/[\\/:*?"<>|]+/g, "_");
      // Distinct sandbox paths can share a basename (…/draft/fig.png vs
      // …/final/fig.png); both landing on one files/<name> destination would
      // make two concurrent downloads clobber each other.
      if (usedSandboxNames.has(name)) {
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let i = 2;
        while (usedSandboxNames.has(`${stem} (${i})${ext}`)) i++;
        name = `${stem} (${i})${ext}`;
      }
      usedSandboxNames.add(name);
      sandboxByPath[sandboxPath] = name;
      sandboxFiles.push({
        name,
        url:
          `${location.origin}/backend-api/conversation/${encodeURIComponent(convId)}` +
          `/interpreter/download?message_id=${encodeURIComponent(msgId)}` +
          `&sandbox_path=${encodeURIComponent(sandboxPath)}`,
      });
    }
  };

  // Assistant text can carry inline `{{file:file-XXX}}` placeholders for
  // canvas/tool-generated files (e.g. a report saved by computer.sync_file) —
  // a separate mechanism from metadata.attachments (user-uploaded files) and
  // image_asset_pointer parts (images). The file's real name lives in a
  // metadata array of citation-like objects `{ type: "file", file_id,
  // file_name, matched_text }`, but the key that array is stored under is
  // scraping-obfuscated and rotates (observed as e.g. "n7jupd_crefs" instead
  // of "content_references") — so scan values by shape, not by key name.
  const FILE_TOKEN = /\{\{file:([^{}]+)\}\}/g;
  const crefFileName = (m, fid) => {
    for (const v of Object.values((m && m.metadata) || {})) {
      if (!Array.isArray(v)) continue;
      for (const item of v) {
        if (item && item.type === "file" && item.file_id === fid && item.file_name) {
          return item.file_name;
        }
      }
    }
    return null;
  };
  const subFileTokens = (text, m) =>
    text.replace(FILE_TOKEN, (_, fid) => {
      if (!withFiles) return "_[file omitted]_";
      pendingFiles.push(fid);
      const name = crefFileName(m, fid);
      if (name && !attMeta[fid]) attMeta[fid] = { name, mime: null };
      return `@@FILE@@${fid}@@`;
    });

  // Image parts emit an ASCII sentinel (substituted before return). Non-image
  // attachments are handled separately (fileMarks).
  const rawTextOf = (m) => {
    const parts = (m.content && m.content.parts) || [];
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (isImagePart(p)) {
          const fid = fileIdOf(p.asset_pointer);
          if (withFiles && fid) {
            pendingFiles.push(fid);
            return `@@IMG@@${fid}@@`;
          }
          return "_[image omitted]_";
        }
        return "";
      })
      .join("\n\n");
  };
  const clean = (s) =>
    stripDirectives(stripCitations(s)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // With footnotes, splice [^n] markers in at each grouped_webpages citation
  // (highest index first so earlier offsets stay valid), then clean.
  const renderText = (m) => {
    let raw = rawTextOf(m);
    if (footnotes) {
      const refs = ((m.metadata && m.metadata.content_references) || [])
        .filter((r) => r.type === "grouped_webpages" && Number.isInteger(r.start_idx) && Number.isInteger(r.end_idx))
        .sort((a, b) => b.start_idx - a.start_idx);
      for (const ref of refs) {
        const markers = (ref.items || [])
          .filter((it) => it && it.url)
          .map((it) => `[^${noteNum(it.url, it.title)}]`)
          .join("");
        raw = raw.slice(0, ref.start_idx) + markers + raw.slice(ref.end_idx);
      }
    }
    // Runs after footnote splicing, which relies on content_references
    // start_idx/end_idx offsets computed against the untouched text — a
    // length-changing substitution has to happen after those offsets are
    // consumed, not before.
    raw = subFileTokens(raw, m);
    return clean(raw);
  };

  // Non-image attachments (PDFs, docs, …) live only in metadata.attachments —
  // append a placeholder link per file (images come from image_asset_pointer
  // parts instead).
  const fileMarks = (m) => {
    if (!withFiles) return "";
    const out = [];
    for (const a of (m.metadata && m.metadata.attachments) || []) {
      if (!a || !a.id || (a.mime_type || "").startsWith("image/")) continue;
      pendingFiles.push(a.id);
      out.push(`@@FILE@@${a.id}@@`);
    }
    return out.length ? "\n\n" + out.join("\n\n") : "";
  };

  const turns = [];
  for (const { id, msg } of path) {
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
    if (msg.recipient && msg.recipient !== "all") continue;

    const role = msg.author && msg.author.role;
    let speaker;
    if (role === "user") speaker = "User";
    else if (role === "assistant") speaker = "ChatGPT";
    else if (role === "tool" && hasImage(msg)) speaker = "ChatGPT";
    else continue;

    for (const a of (msg.metadata && msg.metadata.attachments) || []) {
      if (a && a.id) attMeta[a.id] = { name: a.name, mime: a.mime_type };
    }

    const text = (renderText(msg) + fileMarks(msg) + canvasMark(msg)).trim();
    if (!text) continue;
    if (withFiles) collectSandbox(text, msg.id);
    turns.push({ id, role, md: `## ${speaker}\n\n${text}\n` });
  }

  const result = { convId, title: convo.title || "ChatGPT conversation", turns };
  if (footnotes) result.footnotes = notes;

  if (withFiles) {
    // A 1500-turn thread can carry hundreds of files. Resolve them with bounded
    // concurrency (not one slow round-trip at a time); withDeadline (above)
    // keeps any single stuck request from hanging the pool.
    const POOL = 8;
    const REQUEST_TIMEOUT_MS = 20000;
    const mapPool = async (items, fn) => {
      const out = new Array(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(POOL, items.length) }, worker));
      return out;
    };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

    // The files endpoint returns JSON { download_url, file_name } or redirects
    // to the signed content URL; the native side re-fetches it with the token.
    // Transient failures (429 rate limiting, 5xx, timeouts) are retried against
    // the SAME endpoint shape with a short backoff — falling straight through
    // to the next shape would silently drop the file (and, on a 429, double
    // the request rate at the worst moment).
    const resolveOnce = (ep, auth) =>
      withDeadline(ep, auth, REQUEST_TIMEOUT_MS, async (r) => {
        if (!r.ok) {
          if (r.status === 429 || r.status >= 500) {
            const retryAfter = Number(r.headers.get("retry-after")) || 0;
            return { retryInMs: Math.min((retryAfter || 2) * 1000, 10000) };
          }
          return null;
        }
        const ct = r.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const j = await r.json();
          const url = j.download_url || (j.metadata && j.metadata.download_url);
          if (!url) return null;
          return {
            value: {
              url,
              mime: (j.metadata && j.metadata.mime_type) || j.mime_type || null,
              name: (j.metadata && j.metadata.file_name) || j.file_name || null,
            },
          };
        }
        if (r.redirected || !ct.includes("text/html")) {
          // The URL is all we need — don't keep downloading the body into the
          // tab (the native side fetches the content itself).
          try {
            if (r.body) r.body.cancel();
          } catch (e) {}
          return { value: { url: r.url, mime: ct || null, name: null } };
        }
        return null;
      });
    const resolveURL = async (fid) => {
      const endpoints = [
        `/backend-api/files/download/${encodeURIComponent(fid)}`,
        `/backend-api/files/${encodeURIComponent(fid)}/download`,
      ];
      const auth = { headers: { Authorization: `Bearer ${accessToken}` } };
      for (const ep of endpoints) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const out = await resolveOnce(ep, auth);
            if (out && out.retryInMs) {
              await sleep(out.retryInMs * (attempt + 1));
              continue;
            }
            if (out) return out.value;
            break; // definitive no from this shape — try the next one
          } catch (e) {
            // Timeout/network: one cheap retry, then move on — each attempt
            // already cost up to REQUEST_TIMEOUT_MS.
            if (attempt >= 1) break;
            await sleep(1000);
          }
        }
      }
      return null;
    };

    const files = [];
    const nameByFile = {};
    let unresolved = 0; // files we KNOW about but could not get a URL for
    const fids = [...new Set(pendingFiles)];
    const resolvedList = await mapPool(fids, (fid) => resolveURL(fid));
    fids.forEach((fid, idx) => {
      const resolved = resolvedList[idx];
      if (!resolved) {
        unresolved++;
        return;
      }
      const meta = attMeta[fid] || {};
      const nameHint = resolved.name || meta.name;
      const mime = resolved.mime || meta.mime || "";
      const ext =
        (nameHint && (nameHint.match(/\.[A-Za-z0-9]+$/) || [])[0]) ||
        (/jpe?g/.test(mime) ? ".jpg"
          : /webp/.test(mime) ? ".webp"
          : /gif/.test(mime) ? ".gif"
          : /pdf/.test(mime) ? ".pdf"
          : /png|image/.test(mime) ? ".png"
          : ".bin");
      const name = `${fid}${ext}`;
      nameByFile[fid] = name;
      // kind:"file" marks entries the worker can re-resolve (pageResolveFiles)
      // and retry if the download fails with a retryable error.
      files.push({ fileId: fid, url: resolved.url, name, kind: "file" });
    });
    // interpreter/download returns JSON { download_url: <signed estuary URL> },
    // like the files endpoint — resolve it here, then let the native side fetch
    // the signed URL (with the bearer token), same as images.
    const sandboxResolved = await mapPool(sandboxFiles, async (sf) => {
      try {
        return await withDeadline(
          sf.url,
          { headers: { Authorization: `Bearer ${accessToken}` } },
          REQUEST_TIMEOUT_MS,
          async (r) => {
            if (!r.ok) return null;
            const j = await r.json();
            const dl = j.download_url || (j.metadata && j.metadata.download_url);
            return dl ? { fileId: sf.name, url: dl, name: sf.name, kind: "sandbox" } : null;
          }
        );
      } catch (e) {
        return null; // sandbox file unavailable (ephemeral / expired)
      }
    });
    // Only links whose file actually resolved may be rewritten to files/… —
    // the sandbox is ephemeral, so in an old chat every one of these can 404,
    // and a blind rewrite would fill the export with dead local links.
    const sandboxOK = new Set();
    for (const f of sandboxResolved) {
      if (!f) continue;
      files.push(f);
      sandboxOK.add(f.name);
    }

    // Canvas docs are already fully resolved (their content came from the
    // conversation JSON itself, not a server round-trip) — no fetch needed,
    // just a name. The filename uses the textdoc_id (always filesystem-safe);
    // the human title goes in the link text via attMeta, same convention as
    // the file-cref case above.
    for (const textdocId of canvasFileIds) {
      const doc = canvasDocs[textdocId];
      if (!doc) continue;
      const fid = `canvas:${textdocId}`;
      const name = `canvas-${textdocId}.md`;
      nameByFile[fid] = name;
      attMeta[fid] = { name: `${doc.title || textdocId}.md`, mime: "text/markdown" };
      files.push({ fileId: fid, name, content: doc.content });
    }

    const sub = (md) =>
      md
        .replace(/@@IMG@@([^@]+)@@/g, (_, fid) =>
          nameByFile[fid] ? `![image](files/${nameByFile[fid]})` : "_[image omitted]_"
        )
        .replace(/@@FILE@@([^@]+)@@/g, (_, fid) => {
          const local = nameByFile[fid];
          const orig = (attMeta[fid] && attMeta[fid].name) || local || "file";
          return local ? `📎 [${orig}](files/${local})` : `📎 ${orig} _(unavailable)_`;
        })
        .replace(/\[([^\]]*)\]\(sandbox:(\/[^\s)]+)\)/g, (m0, label, p) => {
          const n = sandboxByPath[p];
          if (n && sandboxOK.has(n)) return `[${label}](files/${n})`;
          return `${label} _(file no longer available)_`;
        })
        .replace(/sandbox:(\/[^\s)]+)/g, (m0, p) => {
          const n = sandboxByPath[p];
          return n && sandboxOK.has(n) ? `files/${n}` : m0;
        });
    result.turns = turns.map((t) => ({ id: t.id, role: t.role, md: sub(t.md) }));
    result.files = files;
    result.token = accessToken;
    if (unresolved) result.unresolved = unresolved;
  }

  if (raw) result.raw = JSON.stringify(convo, null, 2);
  return result;
  } // run()
}

// pageResolveFiles also runs INSIDE the chatgpt.com page (injected by
// background.js) to mint fresh download URLs for files whose first download
// failed with a retryable error: pre-signed URLs expire while a long export
// drains the download pool, so the tail of a big export needs re-signing. It
// must be self-contained for the same executeScript reasons as pageExport.
// Returns { token, urls: { fid -> url } }; fids it can't resolve are absent.
async function pageResolveFiles(fids) {
  const out = { token: null, urls: {} };
  const withDeadline = async (url, opts, ms, use) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
      return await use(r);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const session = await withDeadline("/api/auth/session", null, 15000, (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
    out.token = session && session.accessToken;
  } catch (e) {
    return out;
  }
  if (!out.token) return out;

  const auth = { headers: { Authorization: `Bearer ${out.token}` } };
  const resolveOne = async (fid) => {
    const endpoints = [
      `/backend-api/files/download/${encodeURIComponent(fid)}`,
      `/backend-api/files/${encodeURIComponent(fid)}/download`,
    ];
    for (const ep of endpoints) {
      try {
        const url = await withDeadline(ep, auth, 15000, async (r) => {
          if (!r.ok) return null;
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const j = await r.json();
            return j.download_url || (j.metadata && j.metadata.download_url) || null;
          }
          if (r.redirected || !ct.includes("text/html")) {
            try {
              if (r.body) r.body.cancel();
            } catch (e) {}
            return r.url;
          }
          return null;
        });
        if (url) return url;
      } catch (e) {
        // try the next shape
      }
    }
    return null;
  };
  // Small pool — this is a second pass over a (usually) short failure list.
  const POOL = 4;
  let next = 0;
  const worker = async () => {
    while (next < fids.length) {
      const fid = fids[next++];
      const url = await resolveOne(fid);
      if (url) out.urls[fid] = url;
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, fids.length) }, worker));
  return out;
}
