#!/usr/bin/env bash
#
# Vendors whisper.cpp for the Android NDK build.
#
# Pinned to a tag rather than tracking master: ggml's build flags and the
# token-timestamp behaviour that whisper_jni.cpp depends on both move between releases,
# and a podcast player silently changing how it locates words is not a good surprise.
set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.7.4}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$ROOT/android/app/src/main/cpp/whisper.cpp"

if [ -d "$TARGET/.git" ]; then
  echo "whisper.cpp already vendored at $TARGET"
  echo "Currently on: $(git -C "$TARGET" describe --tags 2>/dev/null || echo unknown)"
  echo "Delete the directory to re-vendor at $WHISPER_TAG."
  exit 0
fi

echo "Fetching whisper.cpp $WHISPER_TAG ..."
rm -rf "$TARGET"
git clone --depth 1 --branch "$WHISPER_TAG" \
  https://github.com/ggml-org/whisper.cpp.git "$TARGET"

echo "Vendored whisper.cpp $WHISPER_TAG into $TARGET"
