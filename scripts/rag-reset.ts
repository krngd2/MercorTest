/**
 * Deletes every document and chunk from the RAG collections.
 *
 * Embeddings from different providers/models/dimensions are not comparable, so
 * switching embedding providers means starting from a clean index.
 *
 *   npm run rag:reset -- --yes
 */
import { client } from "../lib/mongo";
import { CHUNKS_COLLECTION, DOCUMENTS_COLLECTION, ragDb } from "../lib/rag/store";

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error("This deletes every stored document and chunk.");
    console.error("Re-run as: npm run rag:reset -- --yes");
    process.exit(1);
  }

  const db = ragDb();
  for (const name of [CHUNKS_COLLECTION, DOCUMENTS_COLLECTION]) {
    const result = await db.collection(name).deleteMany({});
    console.log(`${name}: deleted ${result.deletedCount} row(s)`);
  }

  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
