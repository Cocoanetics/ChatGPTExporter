// exporter.js
//
// `pageExport` runs INSIDE the chatgpt.com page (injected by popup.js via
// browser.scripting.executeScript). Because it executes in the page's origin,
// its same-origin fetches carry the logged-in session cookies — so it can read
// /api/auth/session, /backend-api/conversation/{id}, and (for images) the file
// download endpoints exactly like the page itself.
//
// It must be fully self-contained: executeScript serializes this function's
// source and runs it in the page, so it cannot reference anything in the
// popup's scope. It returns a plain (structurally cloneable) object.
//
// Returned shape:
//   { convId, title, turns: [{ id, role, md }], images?, raw? }   on success
//   { error: "..." }                                              on failure
//
// `raw` (Option-click) attaches the full conversation JSON. `withImages`
// resolves every image to a pre-signed URL, returns them as
// `images: [{ fileId, url, name }]`, and rewrites the image placeholders to
// `images/<name>` links so a folder export resolves.

async function pageExport(raw, withImages) {
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

  // Web-search citations come wrapped in private-use delimiters, e.g.
  // <U+E200>cite<U+E202>turn0search1<U+E202>…<U+E201>. Build the regex from char
  // codes so the source stays plain ASCII (no invisible characters). Also strip
  // the older 【…】 bracket form.
  const CITE_TOKEN = new RegExp(
    String.fromCharCode(0xe200) + "[\\s\\S]*?" + String.fromCharCode(0xe201),
    "g"
  );
  const stripCitations = (s) => s.replace(CITE_TOKEN, "").replace(/【[^】]*】/g, "");
  const stripDirectives = (s) =>
    s.replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "").replace(/^[ \t]*:::[ \t]*$/gm, "");

  // file-service://file_XYZ / sediment://file_XYZ -> file_XYZ
  const fileIdOf = (ptr) => {
    const s = typeof ptr === "string" ? ptr : "";
    const m = s.match(/^(?:file-service|sediment):\/\/(.+)$/);
    return m ? m[1] : s || null;
  };
  const isImagePart = (p) => p && p.content_type === "image_asset_pointer";
  const hasImage = (m) => ((m.content && m.content.parts) || []).some(isImagePart);

  // With images, image parts emit an ASCII sentinel (survives the cleanup
  // passes; fully substituted before return) instead of the text marker.
  const pendingFiles = [];
  const textOf = (m) => {
    const parts = (m.content && m.content.parts) || [];
    const rendered = parts.map((p) => {
      if (typeof p === "string") return p;
      if (isImagePart(p)) {
        const fid = fileIdOf(p.asset_pointer);
        if (withImages && fid) {
          pendingFiles.push(fid);
          return `@@IMG@@${fid}@@`;
        }
        return "_[image omitted]_";
      }
      return "";
    });
    return stripDirectives(stripCitations(rendered.join("\n\n")))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  // file id -> { name, mime } harvested from message attachments (uploads).
  const attMeta = {};

  const turns = [];
  for (const { id, msg } of path) {
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
    // Drop internal tool-call traffic (image-gen request JSON, the DALL·E
    // prompt, etc.) — those are addressed to a tool, not "all".
    if (msg.recipient && msg.recipient !== "all") continue;

    const role = msg.author && msg.author.role;
    let speaker;
    if (role === "user") speaker = "User";
    else if (role === "assistant") speaker = "ChatGPT";
    else if (role === "tool" && hasImage(msg)) speaker = "ChatGPT"; // generated images
    else continue; // system, or non-image tool output

    for (const a of (msg.metadata && msg.metadata.attachments) || []) {
      if (a && a.id) attMeta[a.id] = { name: a.name, mime: a.mime_type };
    }

    const text = textOf(msg);
    if (!text) continue;
    turns.push({ id, role, md: `## ${speaker}\n\n${text}\n` });
  }

  const result = { convId, title: convo.title || "ChatGPT conversation", turns };

  if (withImages) {
    // Try both known download-endpoint shapes; the pre-signed download_url then
    // needs no auth (the native side fetches it).
    const resolveURL = async (fid) => {
      // The gist's verbatim flow: files/download/{id} returns JSON
      // { download_url, file_name, status }. Keep the alternate shape as a fallback.
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
          } else if (r.redirected || ct.startsWith("image/")) {
            // The endpoint redirected to (or streamed) the signed content URL,
            // e.g. /backend-api/estuary/content?...&sig=... — r.url is that final
            // URL. The native side re-fetches it (with the bearer token).
            return { url: r.url, mime: ct.startsWith("image/") ? ct : null, name: null };
          }
        } catch (e) {
          // try the next shape
        }
      }
      return null;
    };

    const images = [];
    const nameByFile = {};
    for (const fid of new Set(pendingFiles)) {
      const resolved = await resolveURL(fid);
      if (!resolved) continue;
      const meta = attMeta[fid] || {};
      const nameHint = resolved.name || meta.name;
      const mime = resolved.mime || meta.mime;
      const ext =
        (nameHint && (nameHint.match(/\.[A-Za-z0-9]+$/) || [])[0]) ||
        (mime && /jpe?g/.test(mime) ? ".jpg"
          : mime && /webp/.test(mime) ? ".webp"
          : mime && /gif/.test(mime) ? ".gif"
          : ".png");
      const name = `${fid}${ext}`;
      nameByFile[fid] = name;
      images.push({ fileId: fid, url: resolved.url, name });
    }

    const sub = (md) =>
      md.replace(/@@IMG@@([^@]+)@@/g, (_, fid) =>
        nameByFile[fid] ? `![image](images/${nameByFile[fid]})` : "_[image omitted]_"
      );
    result.turns = turns.map((t) => ({ id: t.id, role: t.role, md: sub(t.md) }));
    result.images = images;
    // The native side needs the bearer token to fetch the (backend-api) signed
    // content URLs. Stays within the extension's own components.
    result.token = accessToken;
  }

  if (raw) result.raw = JSON.stringify(convo, null, 2);
  return result;
}
