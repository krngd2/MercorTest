# Document RAG on MongoDB

Source Code : https://github.com/krngd2/MercorTest

A document question-answering app: upload files, they are chunked and embedded
locally into MongoDB. The LLM replies directly to greetings and general questions,
and searches documents when needed for answers grounded in passages with inline citations.

Everything runs on the machine: [EmbeddingGemma 2](https://huggingface.co/google/embeddinggemma-2)
(5-bit MLX) for retrieval and [MiniCPM5-1B](https://huggingface.co/openbmb/MiniCPM5-1B)
(4-bit MLX) for routing, query rewriting, and answers. No API keys or cloud inference; setup downloads dependencies and weights.

Next.js 16 (App Router) · MongoDB (local) · MLX on Apple Silicon.

## Run locally

You need an **Apple Silicon Mac (M1 or newer)**, **Node.js 22+** (includes npm),
**[uv](https://docs.astral.sh/uv/getting-started/installation/)**, and **MongoDB running locally**.
The model servers use MLX; this launcher does not support Intel Macs, Windows, or Linux.

### 1. Install the prerequisites

If you use [Homebrew](https://brew.sh/):

```bash
brew install node uv
brew tap mongodb/brew
brew install mongodb-community@8.0
```

Already have Node.js, uv, or MongoDB? Skip installing those again. Use your
installed MongoDB version in the next command.

### 2. Start MongoDB locally

**Start MongoDB before running the app.** For a Homebrew installation:

```bash
brew services start mongodb-community@8.0
```

Keep MongoDB running while using the app. The default connection is
`mongodb://127.0.0.1:27017/mercor_test`. The launcher checks the connection but
does not install, start, or stop MongoDB for you.
See the [MongoDB macOS guide](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-os-x/)
for other installation options.

### 3. Clone and run

Replace `<repo-url>` with this repository's clone URL:

```bash
git clone <repo-url> mercorTest
cd mercorTest
npm run local
```

That's the only app command you need. It:

1. Creates `.env.local` with local defaults and a generated auth secret, if missing.
2. Installs the app dependencies and checks MongoDB.
3. Sets up Python 3.12 environments and installs the model runtimes using uv.
4. Downloads EmbeddingGemma 2 and MiniCPM5-1B (about **1.7 GB** of model weights).
5. Starts the embedding server, chat server, and web app, and waits for their HTTP endpoints.

Setup needs an internet connection. Allow several minutes for the first run.
Later runs reuse the Python environments and downloaded model files, while
checking dependencies and downloads again. Existing `.env.local` settings are preserved.

When ready, open **http://localhost:3000**, upload a document, and ask a question.
Keep the terminal open. **Press Ctrl+C to stop all three app servers.** MongoDB
keeps running. Next time, run `npm run local` again from the repo folder.

### If something goes wrong

- **MongoDB connection failed:** start MongoDB locally, then retry. If you use a
  different connection string, update `MONGODB_URI` in `.env.local`.
- **Port already in use:** stop existing servers on `3000`, `8098`, or `8099`, then retry.
  The launcher does not kill existing processes.
- **Download interrupted:** run `npm run local` again; downloads can resume.
- **A server failed:** check `.local/logs/embedding.log`, `.local/logs/chat.log`,
  or `.local/logs/web.log`. Logs are replaced on each launch.
- **Cannot reach the local chat server:** check that the chat server is running on
  `127.0.0.1:8098`. Even greetings require this server because the model chooses
  the route and generates the reply. With individual commands, run `npm run chat:serve`.
- **No Metal device available:** MLX needs access to the Mac GPU. Run the model
  servers in a local terminal with GPU access; a restricted sandbox may block it.
- **Old “Searching your documents…” placeholder:** refresh the browser to load
  the updated client. The current pending message is “Thinking…”, since retrieval
  happens only after the model chooses search.

### Individual commands (optional)

After the first setup, you can also run each server in a separate terminal:

```bash
npm run embed:serve    # http://127.0.0.1:8099
npm run chat:serve     # http://127.0.0.1:8098
npm run dev           # http://localhost:3000
```

Use these individual commands for custom ports or model paths. The launcher uses
the standard local URLs in [.env.example](.env.example). The model serve scripts
also accept `EMBEDDING_MODEL_PATH` and `CHAT_MODEL_PATH` overrides.

Check the models while the servers are running:

```bash
npm run embed:check
npm run chat:check
npm run chat:test     # regression tests; no models needed
```

## How it works

```
upload ──► parse ──► chunk ──► embed ──► store

message ──► LLM route decision
                 ├── CHAT ──► LLM conversational reply
                 └── SEARCH ──► rewrite ──► vector + keyword ──► fuse ──► LLM answer + citations
```

Each message follows these steps:

1. The UI shows the message and a “Thinking…” placeholder, then posts the
   conversation and document IDs to `/api/chat`. The API keeps up to 30 turns.
2. MiniCPM classifies the latest message using the conversation. It returns JSON
   with a brief `task` and a `route` of `CHAT` or `SEARCH`. The code follows this
   model decision; there are no greeting keyword rules. Invalid routing output
   gets one correction attempt, then an error rather than an automatic search.
3. For `CHAT`, a separate model call generates a plain-text reply using the
   conversation and general knowledge. This branch skips document retrieval,
   query embedding, and citation generation.
4. For `SEARCH`, the app resolves the user identity, rewrites follow-up questions,
   and searches the user's document chunks. Semantic and keyword searches run
   in parallel, contributing up to 24 candidates each by default. Reciprocal
   Rank Fusion selects up to eight chunks for a 12,000-character context budget.
5. The model answers from those passages. The app validates the answer format
   and citation number, allowing one correction attempt. No retrieved passages
   produces the document-not-found reply without an answer-generation call.
6. The UI replaces the placeholder with the complete reply and any source badges.
   Responses are not streamed.

The intended routing is `CHAT` for greetings and general questions, and `SEARCH`
for requests needing uploaded documents or private facts. These are model
judgments, not guarantees; see the routing limitation below.

| Stage | Module | Notes |
|---|---|---|
| Parse | `lib/rag/parse.ts` | PDF (text layer) via `unpdf`, HTML, and text-like files |
| Chunk | `lib/rag/chunk.ts` | Structure-aware, section-scoped, breadcrumb-prefixed, page/offset preserving |
| Embed | `lib/rag/embed.ts` | Batched, retried, MRL-truncated and re-normalised; EmbeddingGemma 2 on `:8099` |
| Store | `lib/rag/store.ts` | `rag_documents` + `rag_chunks`; embeddings as BSON `BinData(float32)` |
| Retrieve | `lib/rag/search.ts` | Exact kNN over the user's chunks + MongoDB `$text`, fused with RRF |
| Route | `lib/rag/pipeline.ts`, `lib/rag/chat.ts` | Model returns `CHAT` or `SEARCH`; no application greeting overrides |
| Answer | `lib/rag/chat.ts`, `lib/rag/llm.ts` | Separate conversational or document-grounded generation; follow-up query rewriting; MiniCPM5-1B on `:8098` |

## Configuration

Optional tuning (all read from env, see `lib/rag/config.ts`):

| Variable | Default | Purpose |
|---|---|---|
| `RAG_EMBEDDING_MODEL` | `embeddinggemma-2-5bit` | Label stored on every chunk; must match the served model |
| `RAG_EMBEDDING_DIMENSIONS` | `768` | Matryoshka truncation: 768/512/256/128 |
| `RAG_LOCAL_EMBEDDING_URL` | `http://127.0.0.1:8099/v1/embeddings` | Local embedding server |
| `RAG_CHAT_MODEL` | empty (server default) | Routing, answer, and query-rewrite model |
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

# Mocked routing, retrieval-branch, and answer-validation regression tests
npm run chat:test

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
Every call through `lib/rag/llm.ts` explicitly sets
`chat_template_kwargs: { enable_thinking: false }`, including routing, direct
replies, query rewriting, and document answers. The server launcher also sets
`--chat-template-args '{"enable_thinking": false}'`. There is currently no
environment-variable toggle for thinking. The routing decision is still made by
the model; disabling thinking selects its non-thinking generation mode. Enabling
thinking has not been validated as a fix for routing mistakes.

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

- MiniCPM5-1B can misclassify the route, especially after document-related
  conversation. A greeting may incorrectly trigger search and produce a
  document-not-found reply; a document request may incorrectly get a direct
  answer. Routing format validation does not check the correctness of the
  decision. `chat:test` uses mocked model outputs and verifies application
  behavior; `chat:check` exercises the live model, including greetings after a
  document refusal, and can expose these mistakes.
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
