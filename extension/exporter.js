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
// links. `footnotes` converts web-search citations to GFM footnotes.

async function pageExport(raw, withFiles, footnotes) {
  const convId = location.pathname.split("/").filter(Boolean).pop();
  if (!convId) {
    return { error: "No conversation is open. Open a chat first, then export." };
  }

  let accessToken;
  try {
    const session = await fetch("/api/auth/session").then((r) => r.json());
    accessToken = session && session.accessToken;
  } catch (e) {
    return { error: "Could not read the ChatGPT session." };
  }
  if (!accessToken) {
    return { error: "Not logged in to ChatGPT (no access token)." };
  }

  let convo;
  try {
    const res = await fetch(`/backend-api/conversation/${convId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      return { error: `Failed to fetch conversation (HTTP ${res.status}).` };
    }
    convo = await res.json();
  } catch (e) {
    return { error: "Network error fetching the conversation: " + e.message };
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

  // Code-interpreter files are linked as [text](sandbox:/mnt/data/<name>). The
  // live interpreter/download endpoint serves them (bearer-authenticated, like
  // image files); the sandbox is ephemeral, so old chats may 404.
  const collectSandbox = (text, msgId) => {
    for (const mm of text.matchAll(/sandbox:(\/[^\s)]+)/g)) {
      const sandboxPath = mm[1];
      if (sandboxByPath[sandboxPath]) continue;
      const name = (sandboxPath.split("/").pop() || "file").replace(/[\\/:*?"<>|]+/g, "_");
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

    const text = (renderText(msg) + fileMarks(msg)).trim();
    if (!text) continue;
    if (withFiles) collectSandbox(text, msg.id);
    turns.push({ id, role, md: `## ${speaker}\n\n${text}\n` });
  }

  const result = { convId, title: convo.title || "ChatGPT conversation", turns };
  if (footnotes) result.footnotes = notes;

  if (withFiles) {
    // The files endpoint returns JSON { download_url, file_name } or redirects
    // to the signed content URL; the native side re-fetches it with the token.
    const resolveURL = async (fid) => {
      const endpoints = [
        `/backend-api/files/download/${encodeURIComponent(fid)}`,
        `/backend-api/files/${encodeURIComponent(fid)}/download`,
      ];
      for (const ep of endpoints) {
        try {
          const r = await fetch(ep, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const j = await r.json();
            const url = j.download_url || (j.metadata && j.metadata.download_url);
            if (url) {
              return {
                url,
                mime: (j.metadata && j.metadata.mime_type) || j.mime_type || null,
                name: (j.metadata && j.metadata.file_name) || j.file_name || null,
              };
            }
          } else if (r.redirected || !ct.includes("text/html")) {
            return { url: r.url, mime: ct || null, name: null };
          }
        } catch (e) {
          // try the next shape
        }
      }
      return null;
    };

    const files = [];
    const nameByFile = {};
    for (const fid of new Set(pendingFiles)) {
      const resolved = await resolveURL(fid);
      if (!resolved) continue;
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
      files.push({ fileId: fid, url: resolved.url, name });
    }
    for (const sf of sandboxFiles) {
      files.push({ fileId: sf.name, url: sf.url, name: sf.name });
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
        .replace(/sandbox:(\/[^\s)]+)/g, (m0, p) =>
          sandboxByPath[p] ? `files/${sandboxByPath[p]}` : m0
        );
    result.turns = turns.map((t) => ({ id: t.id, role: t.role, md: sub(t.md) }));
    result.files = files;
    result.token = accessToken;
  }

  if (raw) result.raw = JSON.stringify(convo, null, 2);
  return result;
}
