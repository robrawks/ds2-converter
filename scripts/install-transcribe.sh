#!/usr/bin/env bash
# Install the `transcribe` inbox command onto PATH (symlink into ~/.local/bin).
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="${1:-$HOME/.local/bin}"
mkdir -p "$TARGET_DIR"
ln -sf "$REPO_DIR/scripts/transcribe-inbox.sh" "$TARGET_DIR/transcribe"
echo "Installed: $TARGET_DIR/transcribe -> scripts/transcribe-inbox.sh"
echo "Run 'transcribe' to process \$DICTATION_DIR/incoming (default /home/rob/dictation/incoming)."
