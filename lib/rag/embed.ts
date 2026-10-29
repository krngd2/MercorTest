import { LOCAL_EMBEDDING_DIMENSIONS, ragConfig } from "./config";
import { withRetry } from "./http";

/**
 * EmbeddingGemma 2 is trained with asymmetric task prefixes. Documents and
 * queries are embedded with different prefixes, so the two entry points below
 * must stay separate. Values come from the checkpoint's
 * `config_sentence_transformers.json`.
 */
const QUERY_PREFIX = "task: search result | query: ";
const DOCUMENT_PREFIX = "title: none | text: ";

/** Matryoshka sizes the checkpoint was trained to truncate to. */
const MRL_DIMENSIONS = new Set([128, 256, 512, LOCAL_EMBEDDING_DIMENSIONS]);

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Matryoshka truncation: keep the leading dimensions, then re-normalise. Slicing
 * a unit vector does not preserve its length, and skipping the re-normalisation
 * silently degrades cosine ranking.
 */
function truncateAndNormalize(vector: number[], dimensions: number): Float32Array {
  if (vector.length < dimensions) {
    throw new Error(
      `Embedding server returned ${vector.length} dimensions, ` +
        `but ${dimensions} were requested.`,
    );
  }

  const out = new Float32Array(dimensions);
  let sum = 0;
  for (let i = 0; i < dimensions; i += 1) {
    out[i] = vector[i];
    sum += vector[i] * vector[i];
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dimensions; i += 1) out[i] /= norm;
  return out;
}

/**
 * Fetch EmbeddingGemma 2 vectors from the local OpenAI-compatible server
 * (`npm run embed:serve`). The server returns native 768-d, mean-pooled and
 * normalised vectors; MRL truncation happens here so stored dimensions match
 * `RAG_EMBEDDING_DIMENSIONS`.
 */
async function embed(texts: string[]): Promise<Float32Array[]> {
  const {
    embeddingModel,
    embeddingDimensions,
    localEmbeddingUrl,
    localEmbeddingTimeoutMs,
    embedBatchSize,
    embedConcurrency,
  } = ragConfig;

  if (!MRL_DIMENSIONS.has(embeddingDimensions)) {
    throw new Error(
      `EmbeddingGemma 2 supports ${[...MRL_DIMENSIONS].join(", ")} dimensions; ` +
        `RAG_EMBEDDING_DIMENSIONS is ${embeddingDimensions}.`,
    );
  }

  const groups = batches(texts, embedBatchSize);
  const results: Float32Array[][] = new Array(groups.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= groups.length) return;

      const data = await withRetry(async () => {
        let response: Response;
        try {
          response = await fetch(localEmbeddingUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: embeddingModel,
              input: groups[index],
              encoding_format: "float",
            }),
            signal: AbortSignal.timeout(localEmbeddingTimeoutMs),
          });
        } catch (error) {
          throw new Error(
            `Cannot reach the local embedding server at ${localEmbeddingUrl}. ` +
              `Start it with \`npm run embed:serve\`. (${(error as Error).message})`,
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          const error = new Error(
            `Local embeddings failed: ${response.status} ${response.statusText}` +
              (body ? ` — ${body.slice(0, 500)}` : ""),
          ) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }

        const json = (await response.json()) as {
          data?: { index?: number; embedding?: number[] }[];
        };
        if (!json.data?.length) {
          throw new Error("Local embedding server returned no vectors");
        }
        return json.data;
      });

      results[index] = data
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => truncateAndNormalize(item.embedding ?? [], embeddingDimensions));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(embedConcurrency, groups.length) }, worker),
  );

  return results.flat();
}

/** Embed corpus texts (document chunks), in order. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  return embed(texts.map((text) => DOCUMENT_PREFIX + text));
}

/** Embed a search query, which uses the asymmetric query prefix. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embed([QUERY_PREFIX + text]);
  return vector;
}
