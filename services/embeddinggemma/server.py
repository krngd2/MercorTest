#!/usr/bin/env python3
"""OpenAI-compatible text embedding server for EmbeddingGemma 2 on MLX.

Text only on purpose: the app never sends images or audio, and skipping the
processor means no torch/torchvision dependency. Vectors are mean-pooled and
L2-normalised by the model; MRL truncation is applied on request.
"""

from __future__ import annotations

import argparse
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Union

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("embeddinggemma")

DEFAULT_MODEL = os.environ.get("EMBEDDING_MODEL_PATH", "mlx-community/embeddinggemma-2-5bit")
MODEL_ID = os.environ.get("EMBEDDING_MODEL_ID", "embeddinggemma-2-5bit")
NATIVE_DIMENSIONS = 768
MAX_CONTEXT_TOKENS = 8192
MAX_BATCH = 64

_state: dict[str, object] = {}
_load_lock = threading.Lock()
_infer_lock = threading.Lock()


def resolve_model(name: str) -> Path:
    path = Path(name).expanduser()
    if path.exists():
        return path.resolve()
    from mlx_vlm.utils import get_model_path

    return get_model_path(name)


def load_model(name: str):
    with _load_lock:
        if "model" in _state:
            return _state["model"], _state["tokenizer"], _state["path"]

        import mlx.core as mx  # noqa: F401  (ensures Metal is initialised before load)
        from mlx_vlm.embedding_loader import load_embedding_model
        from transformers import AutoTokenizer

        path = resolve_model(name)
        started = time.perf_counter()
        logger.info("Loading EmbeddingGemma 2 from %s", path)
        model = load_embedding_model(path)
        tokenizer = AutoTokenizer.from_pretrained(str(path))
        _state.update(model=model, tokenizer=tokenizer, path=path)
        logger.info("Model ready in %.1fs", time.perf_counter() - started)
        return model, tokenizer, path


def encode(texts: list[str], dimensions: int | None) -> tuple[list[list[float]], int]:
    import mlx.core as mx

    model, tokenizer, _ = load_model(DEFAULT_MODEL)
    max_length = min(int(getattr(tokenizer, "model_max_length", MAX_CONTEXT_TOKENS) or MAX_CONTEXT_TOKENS), MAX_CONTEXT_TOKENS)

    if dimensions is not None and not 0 < dimensions <= NATIVE_DIMENSIONS:
        raise ValueError(
            f"dimensions must be between 1 and {NATIVE_DIMENSIONS}, got {dimensions}"
        )

    vectors: list[list[float]] = []
    tokens = 0

    for start in range(0, len(texts), MAX_BATCH):
        batch = texts[start : start + MAX_BATCH]
        encoded = tokenizer(
            batch,
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="np",
        )
        inputs = {key: mx.array(value) for key, value in encoded.items()}
        with _infer_lock:
            output = model(**inputs)
            embeddings = output.text_embeds
            mx.eval(embeddings)
            rows = np.array(embeddings, dtype=np.float32)
        tokens += int(encoded["attention_mask"].sum())

        if dimensions is not None:
            rows = rows[:, :dimensions]
            norms = np.linalg.norm(rows, axis=1, keepdims=True)
            rows = rows / np.maximum(norms, 1e-12)

        vectors.extend(rows.tolist())

    return vectors, tokens


class EmbeddingsRequest(BaseModel):
    input: Union[str, list[str]]
    model: str | None = None
    encoding_format: str | None = "float"
    dimensions: int | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_model(DEFAULT_MODEL)
    yield


app = FastAPI(title="EmbeddingGemma 2 (MLX)", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ok" if "model" in _state else "loading",
        "model": str(_state.get("path", DEFAULT_MODEL)),
        "dimensions": NATIVE_DIMENSIONS,
    }


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model"}],
    }


@app.post("/v1/embeddings")
async def embeddings(request: EmbeddingsRequest):
    # Async on purpose: MLX GPU streams are thread-local, so inference must run
    # on the same thread that loaded the model (the event loop), not in
    # FastAPI's worker thread pool.
    inputs = [request.input] if isinstance(request.input, str) else request.input
    if not inputs or not all(isinstance(text, str) for text in inputs):
        raise HTTPException(status_code=400, detail="`input` must be a string or list of strings")

    started = time.perf_counter()
    try:
        vectors, tokens = encode(inputs, request.dimensions)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:  # surface the real reason instead of a generic 500
        logger.exception("embedding failed")
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}") from error

    logger.info(
        "embedded %d input(s), %d token(s) in %.0fms",
        len(inputs),
        tokens,
        (time.perf_counter() - started) * 1000,
    )
    return {
        "object": "list",
        "data": [
            {"object": "embedding", "index": index, "embedding": vector}
            for index, vector in enumerate(vectors)
        ],
        "model": request.model or MODEL_ID,
        "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
    }


def main():
    global DEFAULT_MODEL
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("EMBEDDING_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("EMBEDDING_PORT", "8099")))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    DEFAULT_MODEL = args.model
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
