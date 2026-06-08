#!/usr/bin/env node
// Offline renderer that MIRRORS extension/exporter.js's cleanup + turn selection,
// for tuning the Markdown against a raw conversation JSON (⌥ Download JSON).
// Images are placeholdered (no auth offline). Web-search citations are converted
// to GFM footnotes: inline [^n] at each grouped_webpages position + a definition
// block at the end. Prints an artifact scan too.
//
//   node tools/render-md.mjs ~/Downloads/whatever-raw.json [out.md]
//
// Keep the selection/cleanup IN SYNC with exporter.js.
import fs from "node:fs";

const inPath = process.argv[2];
if (!inPath) {
  console.error("usage: node tools/render-md.mjs <conversation.json> [out.md]");
  process.exit(1);
}
const resolve = (p) => p.replace(/^~/, process.env.HOME);
const convo = JSON.parse(fs.readFileSync(resolve(inPath), "utf8"));

// ---- mirror of exporter.js (keep in sync) ----
const CITE_TOKEN = new RegExp(
  String.fromCharCode(0xe200) + "[\\s\\S]*?" + String.fromCharCode(0xe201),
  "g"
);
const stripCitations = (s) => s.replace(CITE_TOKEN, "").replace(/【[^】]*】/g, "");
const stripDirectives = (s) =>
  s.replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "").replace(/^[ \t]*:::[ \t]*$/gm, "");
const isImagePart = (p) => p && p.content_type === "image_asset_pointer";
const hasImage = (m) => ((m.content && m.content.parts) || []).some(isImagePart);

const rawTextOf = (m) => {
  const parts = (m.content && m.content.parts) || [];
  return parts.map((p) => (typeof p === "string" ? p : isImagePart(p) ? "_[image omitted]_" : "")).join("\n\n");
};
const clean = (s) =>
  stripDirectives(stripCitations(s)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// Document-wide footnote registry (dedupe by URL).
const notes = [];
const noteByUrl = new Map();
const noteNum = (url, title) => {
  if (!noteByUrl.has(url)) {
    notes.push({ num: notes.length + 1, title: title || url, url });
    noteByUrl.set(url, notes.length);
  }
  return noteByUrl.get(url);
};

// Splice [^n] markers in for each grouped_webpages citation (highest index first
// so earlier offsets stay valid), then clean the leftover non-web tokens.
const renderText = (m, footnotes) => {
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

const path = [];
for (let id = convo.current_node; id; ) {
  const node = convo.mapping[id];
  if (!node) break;
  if (node.message) path.push({ id, msg: node.message });
  id = node.parent;
}
path.reverse();

const turns = [];
for (const { msg } of path) {
  if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
  if (msg.recipient && msg.recipient !== "all") continue;
  const role = msg.author && msg.author.role;
  let speaker;
  if (role === "user") speaker = "User";
  else if (role === "assistant") speaker = "ChatGPT";
  else if (role === "tool" && hasImage(msg)) speaker = "ChatGPT";
  else continue;
  const text = renderText(msg, true);
  if (!text) continue;
  turns.push(`## ${speaker}\n\n${text}\n`);
}
let md = `# ${convo.title || "ChatGPT conversation"}\n\n` + turns.join("\n");

// Append footnote definitions that are actually referenced.
const used = new Set([...md.matchAll(/\[\^(\d+)\]/g)].map((m) => Number(m[1])));
const defs = notes.filter((n) => used.has(n.num)).map((n) => `[^${n.num}]: [${n.title}](${n.url})`);
if (defs.length) md += "\n" + defs.join("\n") + "\n";
// ---- end mirror ----

const outPath = process.argv[3] ? resolve(process.argv[3]) : resolve(inPath).replace(/\.json$/i, "") + ".md";
fs.writeFileSync(outPath, md, "utf8");

const findings = [];
const pua = [...md].filter((ch) => ch.codePointAt(0) >= 0xe000 && ch.codePointAt(0) <= 0xf8ff);
if (pua.length) findings.push(`private-use chars left: ${pua.length}`);
for (const [label, re] of [
  ["::: directive", /:::/g],
  ["cite/turn/navlist token", /cite[a-z0-9]*|turn\d+\w*|navlist/gi],
]) {
  const hits = md.match(re);
  if (hits) findings.push(`${label}: ${hits.length} - e.g. ${JSON.stringify(hits.slice(0, 4))}`);
}
console.log(`Wrote ${outPath}\n${turns.length} turns, ${defs.length} footnotes, ${md.length} chars`);
console.log("Artifact scan:", findings.length ? findings.join("; ") : "ok - clean");
