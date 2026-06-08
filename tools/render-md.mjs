#!/usr/bin/env node
// Offline renderer that MIRRORS extension/exporter.js's cleanup + turn
// selection, for tuning the Markdown against a raw conversation JSON saved via
// the extension's ⌥ Download JSON. Images are placeholdered (no auth to resolve
// them offline). It also prints an artifact scan so leftovers are easy to spot.
//
//   node tools/render-md.mjs ~/Downloads/whatever-raw.json [out.md]
//
// Keep the selection/cleanup below IN SYNC with exporter.js.
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
const textOf = (m) => {
  const parts = (m.content && m.content.parts) || [];
  const rendered = parts.map((p) =>
    typeof p === "string" ? p : isImagePart(p) ? "_[image omitted]_" : ""
  );
  return stripDirectives(stripCitations(rendered.join("\n\n")))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const text = textOf(msg);
  if (!text) continue;
  turns.push(`## ${speaker}\n\n${text}\n`);
}
const md = `# ${convo.title || "ChatGPT conversation"}\n\n` + turns.join("\n");
// ---- end mirror ----

const outPath = process.argv[3] ? resolve(process.argv[3]) : resolve(inPath).replace(/\.json$/i, "") + ".md";
fs.writeFileSync(outPath, md, "utf8");

// ---- artifact scan ----
const findings = [];
const pua = [...md].filter((ch) => {
  const c = ch.codePointAt(0);
  return c >= 0xe000 && c <= 0xf8ff;
});
if (pua.length) {
  const codes = [...new Set(pua.map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase()))];
  findings.push(`private-use chars (likely citation/smart tokens): ${pua.length} - ${codes.join(", ")}`);
}
for (const [label, re] of [
  ["::: directive", /:::/g],
  ["bracket U+3010/3011", /[【】]/g],
  ["cite/turn/navlist token", /cite[a-z0-9]*|turn\d+\w*|navlist/gi],
  ["sentinel @@IMG@@", /@@IMG@@/g],
]) {
  const hits = md.match(re);
  if (hits) findings.push(`${label}: ${hits.length} - e.g. ${JSON.stringify(hits.slice(0, 4))}`);
}

console.log(`Wrote ${outPath}\n${turns.length} turns, ${md.length} chars`);
console.log("\nArtifact scan:");
console.log(findings.length ? findings.map((f) => "  ! " + f).join("\n") : "  ok - no known markers found");
