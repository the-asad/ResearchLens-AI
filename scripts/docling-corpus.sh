#!/usr/bin/env bash
# Extract every corpus paper with the Docling worker (resumable). Records wall time and peak RSS.
set -u
for f in eval/papers/*.pdf; do
  k=$(basename "$f" .pdf); [ "$k" = "attention-is-all-you-need" ] && continue
  [ -s "eval/cache/docling/$k.json" ] && { echo "skip $k"; continue; }
  /usr/bin/time -l services/docintel/.venv/bin/python services/docintel/extract.py "$f" "eval/cache/docling/$k.json" --images-dir "eval/cache/docling/$k-img" > "eval/cache/docling/$k.log" 2>&1
  echo "$k exit=$? $(grep -E 'real' eval/cache/docling/$k.log | awk '{print $1"s"}') rss=$(grep 'maximum resident' eval/cache/docling/$k.log | awk '{printf "%dMB", $1/1e6}')"
done
