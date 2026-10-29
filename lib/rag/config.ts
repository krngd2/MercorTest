function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Native output size of EmbeddingGemma 2 (Matryoshka: 768/512/256/128). */
export const LOCAL_EMBEDDING_DIMENSIONS = 768;

/**
 * One place for every tunable in the retrieval pipeline. Anything that changes
 * the meaning of a stored vector is also written onto the chunk document, so
 * re-embedding migrations can find stale rows.
 *
 * Both models run locally: EmbeddingGemma 2 (MLX) for retrieval and MiniCPM5-1B
 * (MLX) for query rewriting and answers. There is no cloud provider.
 */
export const ragConfig = {
  embeddingModel: process.env.RAG_EMBEDDING_MODEL ?? "embeddinggemma-2-5bit",
  /**
   * Matryoshka truncation: 768 native, 512/256/128 supported by training.
   * Re-normalised after truncation in `embed.ts`.
   */
  embeddingDimensions: intFromEnv("RAG_EMBEDDING_DIMENSIONS", LOCAL_EMBEDDING_DIMENSIONS),

  /** OpenAI-compatible endpoint of the local EmbeddingGemma 2 server. */
  localEmbeddingUrl:
    process.env.RAG_LOCAL_EMBEDDING_URL ?? "http://127.0.0.1:8099/v1/embeddings",
  localEmbeddingTimeoutMs: intFromEnv("RAG_LOCAL_EMBEDDING_TIMEOUT_MS", 120_000),

  /**
   * Optional model id sent to the chat server. Empty means "whatever the server
   * loaded" (mlx_lm.server maps that to its `--model` argument), which avoids
   * pinning an absolute path or an HF repo id in the app config.
   */
  chatModel: process.env.RAG_CHAT_MODEL ?? "",
  /** OpenAI-compatible endpoint of the local MiniCPM5 chat server. */
  localChatUrl:
    process.env.RAG_LOCAL_CHAT_URL ?? "http://127.0.0.1:8098/v1/chat/completions",
  localChatTimeoutMs: intFromEnv("RAG_LOCAL_CHAT_TIMEOUT_MS", 180_000),

  chunkerVersion: "structure-v1",

  /** ~600 tokens at 4 chars/token. */
  chunkTargetChars: intFromEnv("RAG_CHUNK_TARGET_CHARS", 2400),
  chunkOverlapChars: intFromEnv("RAG_CHUNK_OVERLAP_CHARS", 240),
  minChunkChars: 80,

  maxFileBytes: intFromEnv("RAG_MAX_FILE_BYTES", 20 * 1024 * 1024),

  embedBatchSize: intFromEnv("RAG_EMBED_BATCH_SIZE", 64),
  embedConcurrency: intFromEnv("RAG_EMBED_CONCURRENCY", 4),

  /**
   * Exact kNN scans every chunk belonging to the user. Above this many rows the
   * request is rejected instead of quietly taking seconds.
   */
  maxScanChunks: intFromEnv("RAG_MAX_SCAN_CHUNKS", 20_000),

  vectorCandidates: intFromEnv("RAG_VECTOR_CANDIDATES", 24),
  keywordCandidates: intFromEnv("RAG_KEYWORD_CANDIDATES", 24),
  finalK: intFromEnv("RAG_FINAL_K", 8),
  maxContextChars: intFromEnv("RAG_MAX_CONTEXT_CHARS", 12_000),
} as const;
