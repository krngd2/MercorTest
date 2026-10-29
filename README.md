# Document RAG on MongoDB

A document question-answering app: upload files, they are chunked and embedded
locally into MongoDB. The LLM replies directly to greetings and general questions,
and searches documents when needed for answers grounded in passages with inline citations.

Everything runs on the machine: [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
(5-bit MLX) for retrieval and [MiniCPM5-1B](https://huggingface.co/openbmb/MiniCPM5-1B)
(4-bit MLX) for query rewriting and answers. No API keys, no cloud calls.

Next.js 16 (App Router) · MongoDB (local) · MLX on Apple Silicon.

## How it works

```
upload ──► parse ──► chunk ──► embed ──► store

message ──► LLM decision ──► direct reply
                 │
                 └──► rewrite ──► vector + keyword ──► fuse ──► answer + citations
```

| Stage | Module | Notes |
|---|---|---|
| Parse | `lib/rag/parse.ts` | PDF (text layer) via `unpdf`, HTML, and text-like files |
| Chunk | `lib/rag/chunk.ts` | Structure-aware, section-scoped, breadcrumb-prefixed, page/offset preserving |
| Embed | `lib/rag/embed.ts` | Batched, retried, MRL-truncated and re-normalised; EmbeddingGemma 2 on `:8099` |
| Store | `lib/rag/store.ts` | `rag_documents` + `rag_chunks`; embeddings as BSON `BinData(float32)` |
| Retrieve | `lib/rag/search.ts` | Exact kNN over the user's chunks + MongoDB `$text`, fused with RRF |
| Route | `lib/rag/pipeline.ts`, `lib/rag/chat.ts` | LLM decides between a direct reply and document search; direct replies skip document access |
| Answer | `lib/rag/chat.ts`, `lib/rag/llm.ts` | Query rewrite for follow-ups, token-budgeted context, cited answer; MiniCPM5-1B on `:8098` |

## Setup

```bash
npm install
```

Three processes: the embedding server, the chat server, and Next.js. Use one
terminal per service:

```bash
npm run embed:serve    # http://127.0.0.1:8099/v1/embeddings
npm run chat:serve     # http://127.0.0.1:8098/v1/chat/completions
npm run dev
```

Sanity checks:

```bash
npm run embed:check    # dimensions, prefixes and a ranking check
npm run chat:check     # grounded answers + citations, refusal, follow-up rewrite
npm run chat:test      # response validation regression tests (no model needed)
```

First-time setup of the two Python environments and model weights:

```bash
uv venv --python 3.12 services/embeddinggemma/.venv
uv pip install --python services/embeddinggemma/.venv/bin/python 'mlx-vlm==0.7.11'

uv venv --python 3.12 services/minicpm/.venv
uv pip install --python services/minicpm/.venv/bin/python 'mlx-lm==0.32.2'

npm run embed:download   # 1.13 GB, 5-bit EmbeddingGemma 2
npm run chat:download    # 608 MB, 4-bit MiniCPM5-1B
```

The serve scripts use `models/embeddinggemma-2-5bit` and `models/minicpm5-1b-4bit`
when present, and fall back to the Hugging Face cache. Override with
`EMBEDDING_MODEL_PATH` / `CHAT_MODEL_PATH` to use another MLX conversion (for
example `openbmb/MiniCPM5-2B` or `mlx-community/MiniCPM4.1-8B-4bit`).

`.env.local` needs:

```
MONGODB_URI=mongodb://127.0.0.1:27017/mercor_test

RAG_EMBEDDING_MODEL=embeddinggemma-2-5bit
RAG_EMBEDDING_DIMENSIONS=768
RAG_LOCAL_EMBEDDING_URL=http://127.0.0.1:8099/v1/embeddings

RAG_CHAT_MODEL=minicpm5-1b-4bit
RAG_LOCAL_CHAT_URL=http://127.0.0.1:8098/v1/chat/completions
```

Optional tuning (all read from env, see `lib/rag/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `RAG_EMBEDDING_MODEL` | `embeddinggemma-2-5bit` | Label stored on every chunk; must match the served model |
| `RAG_EMBEDDING_DIMENSIONS` | `768` | Matryoshka truncation: 768/512/256/128 |
| `RAG_LOCAL_EMBEDDING_URL` | `http://127.0.0.1:8099/v1/embeddings` | Local embedding server |
| `RAG_CHAT_MODEL` | `minicpm5-1b-4bit` | Answer + query-rewrite model |
| `RAG_LOCAL_CHAT_URL` | `http://127.0.0.1:8098/v1/chat/completions` | Local chat server |
| `RAG_LOCAL_CHAT_TIMEOUT_MS` | `180000` | Per-request timeout |
| `RAG_CHUNK_TARGET_CHARS` | `2400` | ~600 tokens |
| `RAG_CHUNK_OVERLAP_CHARS` | `240` | Overlap inside a section |
| `RAG_MAX_SCAN_CHUNKS` | `20000` | Exact-search safety limit |
| `RAG_FINAL_K` | `8` | Chunks sent to the model |
| `RAG_DEV_USER_ID` | `dev-user` | Identity used when not signed in |

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/documents` | `GET` | List the current user's documents |
| `/api/documents` | `POST` | Multipart upload, field `file` (ingest is synchronous) |
| `/api/documents/[id]` | `DELETE` | Delete a document and its chunks |
| `/api/chat` | `POST` | `{ messages, documentIds? }` → `{ answer, sources, mode, query, rewrittenQuery, scanned, keywordUsed }`; mode is `direct` or `documents`, query fields are null for direct replies |

## Scripts

```bash
# Inspect chunking without touching the network or database
npm run rag:check -- path/to/doc.md

# Full pipeline check (parse → chunk → embed → store → retrieve)
npm run rag:smoke -- path/to/doc.pdf "what was the biggest cost driver?"

# Verify the local servers
npm run embed:check
npm run chat:check

# Re-download model weights
npm run embed:download
npm run chat:download

# Delete every stored document and chunk (needed when switching embedders)
npm run rag:reset -- --yes
```

## Design decisions

**Exact kNN instead of `$vectorSearch`.** MongoDB Community does not ship the
vector search stage; `$vectorSearch` needs Atlas or a local Atlas deployment
(Docker). This build scans the user's chunks in Node, which is correct and fast
enough up to roughly 20k chunks. `retrieve()` is the only function that needs to
change when moving to Atlas.

**Hybrid retrieval.** Vector search alone misses IDs, names, and exact numbers.
The keyword half uses MongoDB's text index and results are fused with Reciprocal
Rank Fusion, so `cosine` and `textScore` never have to be comparable.

**Section-scoped chunks.** A chunk never spans two headings, and the embedded
text is prefixed with `document > heading > subheading`. This keeps citations
meaningful and improves recall on short sections.

**Embeddings are versioned.** Every chunk records `embeddingModel`,
`embeddingDimensions`, and `chunkerVersion`. Changing any of them means
re-embedding; mixing them in one index silently ruins retrieval. Switching
models is therefore a wipe-and-re-ingest, not an in-place update
(`npm run rag:reset -- --yes`).

**Local embeddings are asymmetric.** EmbeddingGemma 2 was trained with task
prefixes, so `embedQuery` sends `task: search result | query: …` while
`embedTexts` sends `title: none | text: …`. Omitting them still returns vectors,
but retrieval quality drops without any error — the same silent-failure shape as
skipping re-normalisation after MRL truncation.

**The chat model runs without thinking.** MiniCPM5 is a hybrid-reasoning model.
Answers here are extractive, so requests set `chat_template_kwargs.enable_thinking
= false`; the `think` path would add latency and tokens for no retrieval benefit.

**Citations are rendered by the app.** MiniCPM returns JSON containing answer text
and a source number. The app validates both, retries malformed replies once,
and renders the citation itself. Citation-only answers and out-of-range source
numbers are rejected. A misnumbered literal extract can be attributed to a
passage only when its complete text occurs in exactly one supplied passage.
Refusals carry no source citations. This validates response shape and numbering;
it does not prove the factual grounding of paraphrased answers.

**Multimodal input is text-first.** EmbeddingGemma 2 can embed images, audio and
video in the same 768-d space, but this pipeline only sends text. Scanned pages
still need OCR before they can be embedded; using the vision encoder would mean
carrying the processor (and torch) in the model server and a separate embedding
field for media.

## Limitations / next steps

- Two Python sidecars, one model each. They are single-tenant; for multiple
  concurrent users, put them behind a queue or run several processes and
  load-balance.
- Ingest runs inside the upload request. Move it to a background job for large
  files, and stream the answer instead of waiting for the full completion.
- No reranker yet. Add a cross-encoder or hosted rerank on the top 20 candidates.
- Image/table extraction is not implemented; scanned PDFs need OCR.
- Switching to Atlas: create a `vectorSearch` index on `rag_chunks.embedding`
  (`numDimensions` = `RAG_EMBEDDING_DIMENSIONS`, `cosine`) plus `filter` fields
  for `userId` and `documentId`, then replace the scan in `lib/rag/search.ts`
  with `$vectorSearch`.

## Why these runtimes

The embedding checkpoint is new (Sep 2026), so support is uneven:

| Runtime | Embeddings | Chat |
|---|---|---|
| `mlx-lm` | **No.** Its server only exposes `/v1/completions` and `/v1/chat/completions`, and it has no `embedding_gemma2` architecture. | **Yes.** MiniCPM5-1B is a plain `LlamaForCausalLM`, and the official 4-bit MLX conversion plus its chat template load directly. |
| `rapid-mlx` | **Partly.** It ships a native `embedding_gemma2` encoder and `/v1/embeddings`, but its loader accepts only BF16 or **4-bit affine** weights — the 5-bit conversion fails. | Not needed. |
| `mlx-vlm` (used) | **Yes.** `mlx-community` publishes the 5-bit conversion; `embedding_loader.load_embedding_model` handles any quantization, text-only, no torch. | Not used. |

Two details worth knowing:

- The embedding sidecar bypasses `mlx-vlm`'s own HTTP server: that path eagerly
  builds the video processor and requires torch/torchvision. The service calls
  the encoder directly with `AutoTokenizer`, which keeps the environment text-only.
- `mlx-lm` is chat-only here. Using it for embeddings returns 404 on
  `/v1/embeddings`, not a vector.
