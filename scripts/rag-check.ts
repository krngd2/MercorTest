/**
 * Chunker smoke test. No API calls, no database.
 *
 *   npm run rag:check -- path/to/document.md
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chunkDocument, estimateTokens } from "../lib/rag/chunk";

const file = process.argv[2];

if (!file) {
  console.error("usage: npm run rag:check -- <file.md|file.txt>");
  process.exit(1);
}

const text = readFileSync(file, "utf8");
const chunks = chunkDocument({
  title: basename(file),
  pages: [{ text, page: null }],
});

console.log(`${basename(file)}: ${text.length} chars, ${chunks.length} chunks\n`);

for (const chunk of chunks) {
  const crumbs = chunk.headingPath.join(" > ") || "(no headings)";
  console.log(
    `#${chunk.index} tokens=${chunk.tokens} chars=${chunk.text.length} ` +
      `offsets=${chunk.startChar}-${chunk.endChar} headings=${crumbs}`,
  );
  console.log(
    chunk.text.length > 220 ? `${chunk.text.slice(0, 220).replace(/\n/g, " ")}…` : chunk.text,
  );
  console.log(
    `embed prefix: ${chunk.embedText.slice(0, 90).replace(/\n/g, " ")}…`,
  );
  console.log("");
}

const total = chunks.reduce((sum, chunk) => sum + chunk.tokens, 0);
console.log(`total estimated tokens: ${total} (~$${((total / 1_000_000) * 0.13).toFixed(6)} to embed with 3-large)`);
console.log(`sanity: ${estimateTokens(text)} tokens in source`);
