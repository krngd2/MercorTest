#!/usr/bin/env bash
# Mirrors a Hugging Face repo into a local directory with curl.
#
#   scripts/fetch-hf.sh <repo> <dest>
#
# Uses curl rather than `hf download`: huggingface_hub 2.3's httpx2 decoder
# fails on small zstd-compressed files ("process() takes no keyword arguments").
# Resumable and idempotent, so re-running after an interruption is cheap.
set -euo pipefail

repo="${1:?usage: fetch-hf.sh <repo> <dest>}"
dest="${2:?usage: fetch-hf.sh <repo> <dest>}"
base="https://huggingface.co/${repo}/resolve/main"

files="$(curl -fsSL "https://huggingface.co/api/models/${repo}/tree/main?recursive=true" |
  python3 -c 'import sys, json
for entry in json.load(sys.stdin):
    if entry["type"] == "file":
        print(entry["path"])')"

mkdir -p "$dest"

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  target="$dest/$file"
  mkdir -p "$(dirname "$target")"

  remote="$(curl -fsIL "$base/$file" | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n }')"
  if [[ -f "$target" && -n "$remote" && "$(wc -c < "$target" | tr -d ' ')" == "$remote" ]]; then
    echo "ok   $file"
    continue
  fi

  echo "get  $file (${remote:-?} bytes)"
  curl -fL --retry 3 --retry-delay 2 -C - -o "$target" "$base/$file" || {
    status=$?
    # curl -C - exits 33 when the local file is already complete.
    [[ $status -eq 33 ]] || exit $status
  }
done <<< "$files"

echo "done: $dest"
