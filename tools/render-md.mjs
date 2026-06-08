#!/usr/bin/env node
// Offline renderer that MIRRORS extension/exporter.js's cleanup, for tuning the
// Markdown against a raw conversation JSON saved via the extension's Debug mode.
//
//   node tools/render-md.mjs ~/Downloads/Unknown.json [out.md]
//
// Keep the cleanup below IN SYNC with exporter.js. It also prints an artifact
// scan (private-use citation tokens, stray ::: / brackets, control chars, and
// any non-letter non-ASCII characters) so leftovers are easy to spot.
import fs from "node:fs";

const inPath = process.argv[2];
if (!inPath) {
  console.error("usage: node tools/render-md.mjs <conversation.json> [out.md]");
  process.exit(1);
}
const resolve = (p) => p.replace(/^~/, process.env.HOME);
const convo = JSON.parse(fs.readFileSync(resolve(inPath), "utf8"));

// ---- mirror of exporter.js (keep in sync) ----
const stripCitations = (s) => s.replace(/【[^】]*】/g, "");
const stripDirectives = (s) =>
  s.replace(/:::[A-Za-z][\w-]*(?:\{[^}]*\})?/g, "").replace(/^[ \t]*:::[ \t]*$/gm, "");
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
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const pathNodes = [];
for (let id = convo.current_node; id; ) {
  const node = convo.mapping[id];
  if (!node) break;
  if (node.message) pathNodes.push({ id, msg: node.message });
  id = node.parent;
}
pathNodes.reverse();

const turns = [];
for (const { msg } of pathNodes) {
  const role = msg.author && msg.author.role;
  if (role !== "user" && role !== "assistant") continue;
  if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
  const text = textOf(msg);
  if (!text) continue;
  turns.push(`## ${role === "user" ? "User" : "ChatGPT"}\n\n${text}\n`);
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
]) {
  const hits = md.match(re);
  if (hits) findings.push(`${label}: ${hits.length} - e.g. ${JSON.stringify(hits.slice(0, 4))}`);
}
const weird = {};
for (const ch of md) {
  const c = ch.codePointAt(0);
  if (c < 128 || /\p{L}/u.test(ch) || /\p{Emoji}/u.test(ch)) continue;
  weird[ch] = (weird[ch] || 0) + 1;
}
const weirdList = Object.entries(weird).map(
  ([ch, n]) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}x${n}`
);

console.log(`Wrote ${outPath}\n${turns.length} turns, ${md.length} chars`);
console.log("\nArtifact scan:");
console.log(findings.length ? findings.map((f) => "  ! " + f).join("\n") : "  ok - no known markers found");
console.log("\nNon-letter non-ASCII chars (spaces/punctuation/symbols):");
console.log("  " + (weirdList.join("  ") || "(none)"));
