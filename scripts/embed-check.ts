/**
 * Verifies the local EmbeddingGemma 2 server: dimensions, prefixes, and whether
 * a known pair actually ranks correctly.
 *
 *   npm run embed:check
 *
 * This is the fastest way to prove the sidecar is healthy before uploading
 * documents.
 */
import { ragConfig } from "../lib/rag/config";
import { embedQuery, embedTexts } from "../lib/rag/embed";

const QUERY = "Which planet is known as the Red Planet?";
const DOCUMENTS = [
  "Mars, known for its reddish appearance, is often called the Red Planet.",
  "Venus is often called Earth's twin because of its similar size.",
  "The northern lights are caused by charged particles from the Sun.",
];

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main() {
  console.log(
    `model=${ragConfig.embeddingModel} dims=${ragConfig.embeddingDimensions}`,
  );

  const started = performance.now();
  const query = await embedQuery(QUERY);
  const documents = await embedTexts(DOCUMENTS);
  const elapsed = Math.round(performance.now() - started);

  if (query.length !== ragConfig.embeddingDimensions) {
    throw new Error(
      `query vector is ${query.length}-d, expected ${ragConfig.embeddingDimensions}-d`,
    );
  }

  const scores = documents.map((document) => cosine(query, document));
  scores.forEach((score, index) => console.log(`  ${score.toFixed(4)}  ${DOCUMENTS[index]}`));

  const best = scores.indexOf(Math.max(...scores));
  if (best !== 0) {
    throw new Error(
      `ranking looks wrong: expected the Mars passage (doc 0) to win, got doc ${best}. ` +
        `Check that the query and document prefixes are applied.`,
    );
  }
  console.log("\nok: Mars passage ranked first");

  console.log(`done in ${elapsed}ms`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
