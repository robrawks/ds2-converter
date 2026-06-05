#!/usr/bin/env bash
# One-time setup for ds2-transcribe: build a venv, install faster-whisper,
# and pre-download the Whisper model so all later runs are fully offline.
#
# Idempotent — safe to re-run. Usage:
#   bash scripts/setup-whisper.sh [model]      # default model: base.en
set -euo pipefail

MODEL="${1:-base.en}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TRANSCRIBE_DIR="$REPO_DIR/transcribe"
VENV_DIR="$TRANSCRIBE_DIR/.venv"
MODELS_DIR="$TRANSCRIBE_DIR/models"
PY="$VENV_DIR/bin/python"

echo "==> ds2-transcribe setup (model: $MODEL)"
echo "    repo: $REPO_DIR"

# 1. venv
if [ ! -x "$PY" ]; then
  echo "==> creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
else
  echo "==> venv already exists"
fi

# 2. deps
echo "==> installing dependencies (this pulls ctranslate2/onnxruntime/av, ~300 MB)"
"$PY" -m pip install --upgrade pip >/dev/null
"$PY" -m pip install -r "$TRANSCRIBE_DIR/requirements.txt"

# 3. pre-download the model (one-time network use; afterwards fully offline)
mkdir -p "$MODELS_DIR"
echo "==> downloading model '$MODEL' into $MODELS_DIR"
"$PY" - "$MODEL" "$MODELS_DIR" <<'PYEOF'
import sys
from faster_whisper import WhisperModel
model_name, models_dir = sys.argv[1], sys.argv[2]
# local_files_only=False -> allowed to fetch from HuggingFace this once.
WhisperModel(model_name, device="cpu", compute_type="int8_float32",
             download_root=models_dir, local_files_only=False)
print(f"   model '{model_name}' cached.")
PYEOF

echo ""
echo "==> Done. ds2-transcribe is ready and runs fully offline."
echo "    Try:  $REPO_DIR/bin/ds2-transcribe path/to/recording.ds2"
echo "    (optionally symlink bin/ds2-transcribe onto your PATH)"
