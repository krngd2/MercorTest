#!/usr/bin/env bash
# OpenAI-compatible chat server backed by MiniCPM5-1B (4-bit MLX).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

if [[ ! -x "$here/.venv/bin/python" ]]; then
  cat >&2 <<'EOF'
Python environment missing. Create it with:

  uv venv --python 3.12 services/minicpm/.venv
  uv pip install --python services/minicpm/.venv/bin/python 'mlx-lm==0.32.2'
EOF
  exit 1
fi

model="${CHAT_MODEL_PATH:-}"
if [[ -z "$model" ]]; then
  if [[ -f "$root/models/minicpm5-1b-4bit/model.safetensors" ]]; then
    model="$root/models/minicpm5-1b-4bit"
  else
    model="openbmb/MiniCPM5-1B-MLX"
  fi
fi

echo "MiniCPM5-1B (MLX): $model"
exec "$here/.venv/bin/python" -m mlx_lm.server \
  --model "$model" \
  --host "${CHAT_HOST:-127.0.0.1}" \
  --port "${CHAT_PORT:-8098}" \
  --max-tokens 1024 \
  --chat-template-args '{"enable_thinking": false}'
