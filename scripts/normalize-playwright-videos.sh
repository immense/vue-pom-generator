#!/usr/bin/env bash

set -euo pipefail

target_dir="${1:-}"

if [ -z "$target_dir" ]; then
  echo "Usage: bash ./scripts/normalize-playwright-videos.sh <directory>"
  exit 1
fi

if [ ! -d "$target_dir" ]; then
  echo "No ${target_dir} directory present; nothing to normalize."
  exit 0
fi

shopt -s nullglob
mp4s=("${target_dir}"/*.mp4)

if [ "${#mp4s[@]}" -eq 0 ]; then
  echo "No MP4s under ${target_dir}; nothing to normalize."
  exit 0
fi

ffmpeg_scale="$(node ./scripts/playwright-video-settings.mjs ffmpeg-scale)"

for mp4 in "${mp4s[@]}"; do
  normalized="${mp4%.mp4}.normalized.mp4"

  ffmpeg -y \
    -i "$mp4" \
    -map 0:v:0 \
    -map 0:a? \
    -vf "scale=${ffmpeg_scale}:flags=lanczos" \
    -c:v libx264 \
    -preset medium \
    -crf 23 \
    -pix_fmt yuv420p \
    -c:a copy \
    -movflags +faststart \
    "$normalized" \
    >/dev/null 2>&1

  mv "$normalized" "$mp4"
done
