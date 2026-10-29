#!/usr/bin/env bash
# OpenAI-compatible embedding server backed by EmbeddingGemma 2 on MLX.
# Text-only: the /v1/embeddings route is the only surface this app uses.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [[ ! -x "$here/.venv/bin/python" ]]; then
  cat >&2 <<'EOF'
Python environment missing. Create it with:

  uv venv --python 3.12 services/embeddinggemma/.venv
  uv pip install --python services/embeddinggemma/.venv/bin/python 'mlx-vlm==0.7.11'
EOF
  exit 1
fi

model="${EMBEDDING_MODEL_PATH:-}"
if [[ -z "$model" ]]; then
  if [[ -f "$root/models/embeddinggemma-2-5bit/model.safetensors" ]]; then
    model="$root/models/embeddinggemma-2-5bit"
  else
    model="mlx-community/embeddinggemma-2-5bit"
  fi
fi

echo "EmbeddingGemma 2 (MLX): $model"
exec "$here/.venv/bin/python" "$here/server.py" \
  --model "$model" \
  --host "${EMBEDDING_HOST:-127.0.0.1}" \
  --port "${EMBEDDING_PORT:-8099}"
