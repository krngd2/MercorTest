/**
 * End-to-end pipeline check: parse → chunk → embed → store → hybrid retrieve.
 * Uses the local EmbeddingGemma 2 server, so run `npm run embed:serve` first.
 *
 *   npm run rag:smoke -- path/to/document.md "your question"
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
};

async function main() {
  const filePath = process.argv[2];
  const question = process.argv[3] ?? "What are the main points?";

  if (!filePath) {
    console.error('usage: npm run rag:smoke -- <file> ["question"]');
    process.exit(1);
  }

  const { client } = await import("../lib/mongo");
  const { ingestFile, deleteDocument } = await import("../lib/rag/ingest");
  const { retrieve } = await import("../lib/rag/search");

  const userId = "rag-smoke-test";
  const name = basename(filePath);
  const file = new File([readFileSync(filePath)], name, {
    type: MIME[extname(name).toLowerCase()] ?? "text/plain",
  });

  try {
    console.log(`ingesting ${name} (${file.size} bytes)…`);
    const document = await ingestFile({ userId, file });
    console.log(
      `stored ${document.chunkCount} chunks from ${document.pageCount} page(s), ` +
        `status=${document.status}`,
    );

    console.log(`\nquery: ${question}`);
    const result = await retrieve({ userId, query: question });
    console.log(
      `scanned=${result.scanned} keyword=${result.keywordUsed} ` +
        `hits=${result.chunks.length}\n`,
    );

    result.chunks.forEach((chunk, index) => {
      const where = chunk.page ? `p.${chunk.page}` : "p.—";
      console.log(
        `${index + 1}. score=${chunk.score.toFixed(4)} [${chunk.matchedBy.join("+")}] ` +
          `${chunk.documentName} ${where} ${chunk.headingPath.join(" > ")}`,
      );
      console.log(`   ${chunk.text.slice(0, 160).replace(/\s+/g, " ")}…`);
    });

    await deleteDocument(userId, document.id);
    console.log("\ncleaned up test document");
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
