// exporter.js
//
// `pageExport` runs INSIDE the chatgpt.com page (injected by popup.js via
// browser.scripting.executeScript). Because it executes in the page's origin,
// its same-origin fetches carry the logged-in session cookies — so it can read
// /api/auth/session and /backend-api/conversation/{id} exactly like the page
// itself, with no token handling on our side.
//
// It must be fully self-contained: executeScript serializes this function's
// source and runs it in the page, so it cannot reference anything in the
// popup's scope. It returns a plain (structurally cloneable) object.
//
// Returned shape:
//   { convId, title, turns: [{ id, role, md }] }   on success
//   { error: "..." }                                on failure
//
// Note: it returns ALL visible turns on the active path (not pre-filtered).
// The popup diffs them against the per-conversation watermark in extension
// storage and emits only what is new.

async function pageExport(debug) {
  const convId = location.pathname.split("/").filter(Boolean).pop();
  if (!convId) {
    return { error: "No conversation is open. Open a chat first, then export." };
  }

  // 1. Access token from the in-page session (cookie-authenticated).
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

  // 2. The full conversation, including its branch tree (`mapping`) and the
  //    active leaf (`current_node`).
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

  // 3. Linearize the ACTIVE path: walk current_node -> parent -> ... -> root,
  //    then reverse. This is the thread you actually see; a naive children
  //    walk would also pull abandoned regenerations/edits.
  const path = [];
  for (let id = convo.current_node; id; ) {
    const node = convo.mapping[id];
    if (!node) break;
    if (node.message) path.push({ id, msg: node.message });
    id = node.parent;
  }
  path.reverse();

  // 4. Render each visible turn. Assistant text is already Markdown, so this is
  //    mostly stitching: drop the U+3010..U+3011 inline citation markers and
  //    placeholder images (their bytes live behind authenticated URLs).
  const stripCitations = (s) => s.replace(/【[^】]*】/g, "");
  // ChatGPT sometimes wraps text in remark-style container directives, e.g.
  // :::writing{variant="chat_message" id="84731"} … :::  — strip the markers and
  // keep the inner text. Straight or curly quotes inside the braces are fine.
  const stripDirectives = (s) =>
    s
      .replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "") // opening, e.g. :::writing{...}
      .replace(/^[ \t]*:::[ \t]*$/gm, ""); // closing ::: on its own line
  const textOf = (m) => {
    const parts = (m.content && m.content.parts) || [];
    const rendered = parts.map((p) =>
      typeof p === "string"
        ? p
        : p && p.content_type === "image_asset_pointer"
        ? "_[image omitted]_"
        : ""
    );
    return stripDirectives(stripCitations(rendered.join("\n\n")))
      .replace(/[ \t]+\n/g, "\n") // trailing spaces left by removed markers
      .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
      .trim();
  };

  const turns = [];
  for (const { id, msg } of path) {
    const role = msg.author && msg.author.role;
    if (role !== "user" && role !== "assistant") continue; // skip system/tool
    if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
    const text = textOf(msg);
    if (!text) continue;
    const heading = role === "user" ? "User" : "ChatGPT";
    turns.push({ id, role, md: `## ${heading}\n\n${text}\n` });
  }

  const result = {
    convId,
    title: convo.title || "ChatGPT conversation",
    turns,
  };
  // Debug mode also returns the full raw conversation JSON — the whole mapping
  // tree with every content_type and metadata field — so cleanup rules can be
  // tuned against ground truth.
  if (debug) result.raw = JSON.stringify(convo, null, 2);
  return result;
}
