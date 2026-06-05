#!/usr/bin/env bash
# Inbox runner: transcribe every DS2/DSS/WAV file dropped in the incoming folder,
# write the .txt transcripts to the transcripts folder, and archive the processed
# source files so re-running never double-processes.
#
# Intended to be installed on PATH as `transcribe` (see scripts/install-transcribe.sh).
#
# Folders (override with the DICTATION_DIR env var; default /home/rob/dictation):
#   $DICTATION_DIR/incoming     <- push .ds2 files here
#   $DICTATION_DIR/transcripts  -> .txt output lands here
#   $DICTATION_DIR/processed    -> source files moved here after success
set -euo pipefail

DICTATION_DIR="${DICTATION_DIR:-/home/rob/dictation}"
INCOMING="$DICTATION_DIR/incoming"
TRANSCRIPTS="$DICTATION_DIR/transcripts"
PROCESSED="$DICTATION_DIR/processed"

# Resolve ds2-transcribe relative to this script so it works regardless of cwd,
# following the symlink when invoked as `transcribe` from ~/.local/bin.
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
REPO_DIR="$(cd "$(dirname "$SELF")/.." && pwd)"
DS2_TRANSCRIBE="$REPO_DIR/bin/ds2-transcribe"

mkdir -p "$INCOMING" "$TRANSCRIPTS" "$PROCESSED"

# Collect inputs (case-insensitive extensions), handle the empty case cleanly.
shopt -s nullglob nocaseglob
files=("$INCOMING"/*.ds2 "$INCOMING"/*.dss "$INCOMING"/*.wav)
shopt -u nullglob nocaseglob

if [ ${#files[@]} -eq 0 ]; then
  echo "Nothing to transcribe — $INCOMING is empty."
  echo "Drop .ds2 files there and run 'transcribe' again."
  exit 0
fi

echo "Transcribing ${#files[@]} file(s) from $INCOMING"
echo "  transcripts -> $TRANSCRIPTS"
echo "  processed   -> $PROCESSED"
echo ""

exec "$DS2_TRANSCRIBE" \
  -o "$TRANSCRIPTS" \
  --archive-dir "$PROCESSED" \
  "${files[@]}"
