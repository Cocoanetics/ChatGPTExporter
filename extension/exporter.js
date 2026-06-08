// exporter.js
//
// `pageExport` runs INSIDE the chatgpt.com page (injected by popup.js via
// browser.scripting.executeScript). Because it executes in the page's origin,
// its same-origin fetches carry the logged-in session cookies — so it can read
// /api/auth/session, /backend-api/conversation/{id}, and (for images)
// /backend-api/files/download/{id} exactly like the page itself.
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
// resolves every image_asset_pointer to a pre-signed URL, returns them as
// `images: [{ fileId, url, name }]`, and rewrites the turns' image placeholders
// to `images/<name>` links so a folder export resolves.
//
// NOTE: the image_asset_pointer locations and the /files/download response shape
// are handled defensively below — verify against a Debug (raw-JSON) capture of a
// thread that actually contains images.

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

  const stripCitations = (s) => s.replace(/【[^】]*】/g, "");
  const stripDirectives = (s) =>
    s.replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "").replace(/^[ \t]*:::[ \t]*$/gm, "");

  // file-service://file-XYZ / sediment://file-XYZ -> file-XYZ
  const fileIdOf = (ptr) => {
    const s = typeof ptr === "string" ? ptr : "";
    const m = s.match(/^(?:file-service|sediment):\/\/(.+)$/);
    return m ? m[1] : s || null;
  };

  // With images, image parts emit an ASCII sentinel (survives the cleanup
  // passes; fully substituted before return) instead of the text marker.
  const pendingFiles = [];
  const textOf = (m) => {
    const parts = (m.content && m.content.parts) || [];
    const rendered = parts.map((p) => {
      if (typeof p === "string") return p;
      if (p && p.content_type === "image_asset_pointer") {
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

  const turns = [];
  for (const { id, msg } of path) {
    const role = msg.author && msg.author.role;
    if (role !== "user" && role !== "assistant") continue;
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
    const text = textOf(msg);
    if (!text) continue;
    turns.push({ id, role, md: `## ${role === "user" ? "User" : "ChatGPT"}\n\n${text}\n` });
  }

  const result = { convId, title: convo.title || "ChatGPT conversation", turns };

  if (withImages) {
    const images = [];
    const nameByFile = {};
    for (const fid of new Set(pendingFiles)) {
      let url = null;
      let mime = null;
      let serverName = null;
      try {
        const r = await fetch(`/backend-api/files/download/${encodeURIComponent(fid)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (r.ok) {
          const j = await r.json();
          url = j.download_url || (j.metadata && j.metadata.download_url) || null;
          mime = (j.metadata && (j.metadata.mime_type || j.metadata.mimeType)) || j.mime_type || null;
          serverName = (j.metadata && j.metadata.file_name) || j.file_name || null;
        }
      } catch (e) {
        // unresolved image — leave it as a placeholder
      }
      if (!url) continue;
      const fromName = serverName && (serverName.match(/\.[A-Za-z0-9]+$/) || [])[0];
      const ext =
        fromName ||
        (mime && /jpe?g/.test(mime) ? ".jpg"
          : mime && /webp/.test(mime) ? ".webp"
          : mime && /gif/.test(mime) ? ".gif"
          : ".png");
      const name = `${fid}${ext}`;
      nameByFile[fid] = name;
      images.push({ fileId: fid, url, name });
    }

    const sub = (md) =>
      md.replace(/@@IMG@@([^@]+)@@/g, (_, fid) =>
        nameByFile[fid] ? `![image](images/${nameByFile[fid]})` : "_[image omitted]_"
      );
    result.turns = turns.map((t) => ({ id: t.id, role: t.role, md: sub(t.md) }));
    result.images = images;
  }

  if (raw) result.raw = JSON.stringify(convo, null, 2);
  return result;
}
