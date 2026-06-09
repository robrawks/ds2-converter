#!/usr/bin/env python3
"""ds2-transcribe: fully-offline DS2/DSS/WAV -> text via faster-whisper.

One-shot pipeline: decode an Olympus .ds2/.dss dictation file (or a .wav) to
PCM in memory, then transcribe with a local Whisper model. No API keys, no
cloud, no intermediate audio file. Designed for the headless VPS path:

    ds2-transcribe recording.ds2            # writes recording.txt
    ds2-transcribe -o transcripts *.ds2
    ds2-transcribe --json *.ds2 > results.jsonl

Run scripts/setup-whisper.sh once first to build the venv and download the
model (large-v3 by default) into transcribe/models/ (after that everything is
offline).
"""

import argparse
import contextlib
import io
import json
import os
import sys
import time
import wave
from pathlib import Path

import numpy as np

# Vendored, patched hirparak decoder (script-relative so cwd doesn't matter).
VENDOR = Path(__file__).resolve().parent / "vendor"
MODELS_DIR = Path(__file__).resolve().parent / "models"
sys.path.insert(0, str(VENDOR))

import ds2decode  # noqa: E402  (vendored)
import dss_decode  # noqa: E402  (vendored)

WHISPER_RATE = 16000
DS2_MAGIC = b"\x03ds2"
DSS_MAGICS = (b"\x02dss", b"\x03dss")
ENC_MAGIC = b"\x03enc"  # encrypted DS2 — out of scope for v1

# Rough transcription speed as a multiple of realtime (int8), used only for the
# "no output until done" ETA so a long file doesn't look hung — being off by 2x
# is harmless and it intentionally errs toward over-estimating. large-v3 is
# measured at ~1x realtime on this 8-core CPU; smaller models are progressively
# faster (rough estimates, since CPU inference scales sub-linearly with cores).
REALTIME_FACTOR = {
    "tiny": 10.0, "tiny.en": 10.0,
    "base": 6.0, "base.en": 6.0,
    "small": 3.0, "small.en": 3.0,
    "medium": 1.5, "medium.en": 1.5,
    "large": 0.8, "large-v1": 0.8, "large-v2": 0.8, "large-v3": 0.8,
}


def detect_format(path):
    """Return one of: 'ds2', 'dss', 'wav', 'encrypted', 'unknown'.

    Content-based (not extension-based), tolerant of a short DMA preamble.
    """
    with open(path, "rb") as f:
        head = f.read(64)
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    stripped = ds2decode._strip_preamble(head)
    if stripped[:4] == DS2_MAGIC:
        return "ds2"
    if stripped[:4] in DSS_MAGICS:
        return "dss"
    # Encrypted files carry the \x03enc magic (possibly behind a preamble).
    for off in range(min(len(head) - 4, 8) + 1):
        if head[off:off + 4] == ENC_MAGIC:
            return "encrypted"
    return "unknown"


def _decode_quiet(fn, *args):
    """Run a vendored decoder, swallowing its progress prints to stdout."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args)


def decode_to_int16(path, fmt):
    """Decode a file to (int16 numpy array, sample_rate)."""
    if fmt == "wav":
        with wave.open(str(path), "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError(f"WAV must be 16-bit PCM (got {w.getsampwidth()*8}-bit)")
            rate = w.getframerate()
            nch = w.getnchannels()
            raw = w.readframes(w.getnframes())
        samples = np.frombuffer(raw, dtype=np.int16)
        if nch > 1:
            samples = samples.reshape(-1, nch).mean(axis=1).astype(np.int16)
        return samples, rate
    if fmt == "ds2":
        dec = ds2decode.DS2Decoder()
        samples = _decode_quiet(dec.decode_file, str(path))
        return samples, dec.sample_rate
    if fmt == "dss":
        dec = dss_decode.DSSDecoder()
        samples = _decode_quiet(dec.decode_file, str(path))
        return samples, dss_decode.DSS_SP_SAMPLE_RATE
    raise ValueError(f"cannot decode format: {fmt}")


def to_whisper_audio(samples_int16, rate):
    """int16 @ rate -> float32 mono @ 16 kHz (resample only if needed)."""
    audio = samples_int16.astype(np.float32) / 32768.0
    if rate != WHISPER_RATE:
        from scipy.signal import resample_poly

        g = np.gcd(rate, WHISPER_RATE)
        audio = resample_poly(audio, WHISPER_RATE // g, rate // g).astype(np.float32)
    return audio


class Transcriber:
    """Lazily-loaded faster-whisper model, reused across files."""

    def __init__(self, model_name, threads, language):
        self.model_name = model_name
        self.threads = threads
        self.language = language
        self._model = None

    def _load(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise RuntimeError(
                "faster-whisper is not installed. Run scripts/setup-whisper.sh first."
            ) from e
        try:
            self._model = WhisperModel(
                self.model_name,
                device="cpu",
                compute_type="int8_float32",
                cpu_threads=self.threads,
                download_root=str(MODELS_DIR),
                local_files_only=True,
            )
        except Exception as e:
            raise RuntimeError(
                f"Could not load model '{self.model_name}' from {MODELS_DIR}. "
                "Run scripts/setup-whisper.sh to download it. "
                f"(underlying error: {e})"
            ) from e
        return self._model

    def transcribe(self, audio_f32):
        model = self._load()
        segments, _info = model.transcribe(
            audio_f32,
            language=self.language,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments)
        return " ".join(text.split())  # normalize whitespace


def _fmt_eta(seconds):
    """Human-friendly ETA: seconds under 90s, otherwise rounded minutes."""
    if seconds >= 90:
        return f"~{round(seconds / 60)} min"
    return f"~{seconds}s"


def out_path_for(input_path, out_dir):
    base = Path(input_path).stem + ".txt"
    return Path(out_dir) / base if out_dir else Path(input_path).with_suffix(".txt")


def process_one(path, transcriber, out_dir, archive_dir=None, verbose=False):
    result = {
        "input": str(path),
        "output": None,
        "status": "pending",
        "format": None,
        "durationSec": None,
        "words": None,
        "elapsedMs": None,
        "archived": None,
        "error": None,
    }
    start = time.perf_counter()
    try:
        fmt = detect_format(path)
        result["format"] = fmt
        if fmt == "encrypted":
            raise ValueError("encrypted DS2 (\\x03enc) — out of scope for v1")
        if fmt == "unknown":
            raise ValueError("not a recognized DS2/DSS/WAV file")

        samples, rate = decode_to_int16(path, fmt)
        result["durationSec"] = round(len(samples) / rate, 2)
        audio = to_whisper_audio(samples, rate)

        if verbose:
            # Rough ETA so a long file doesn't look hung. Speed depends heavily
            # on the model, so scale by its realtime factor (see REALTIME_FACTOR).
            factor = REALTIME_FACTOR.get(transcriber.model_name, 1.0)
            eta = max(1, round(result["durationSec"] / factor))
            log(f"        {result['durationSec']:.0f}s audio — transcribing "
                f"({_fmt_eta(eta)} on CPU, no output until done)...")

        text = transcriber.transcribe(audio)
        out = out_path_for(path, out_dir)
        out.write_text(text + "\n", encoding="utf-8")

        result["output"] = str(out)
        result["words"] = len(text.split())
        result["status"] = "ok"

        # Only move the source AFTER a successful transcript write. Failed files
        # stay put so a re-run retries them. Never archive in-place (out == src dir).
        if archive_dir:
            result["archived"] = _archive(path, archive_dir)
    except Exception as e:
        result["status"] = "failed"
        result["error"] = str(e)
    result["elapsedMs"] = round((time.perf_counter() - start) * 1000)
    return result


def _archive(src, archive_dir):
    """Move a successfully-processed source file into archive_dir.

    Avoids clobbering an existing file of the same name by suffixing -1, -2, ...
    Returns the destination path as a string.
    """
    import shutil

    src = Path(src)
    dest_dir = Path(archive_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    n = 1
    while dest.exists():
        dest = dest_dir / f"{src.stem}-{n}{src.suffix}"
        n += 1
    shutil.move(str(src), str(dest))
    return str(dest)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="ds2-transcribe",
        description="Fully-offline DS2/DSS/WAV -> text via local Whisper.",
    )
    parser.add_argument("files", nargs="+", help="input .ds2 / .dss / .wav files")
    parser.add_argument("-o", "--out-dir", default=None,
                        help="output directory (default: alongside each input)")
    parser.add_argument("-m", "--model", default="large-v3",
                        help="whisper model (default: large-v3; use base.en/small.en "
                             "for much faster, lower-accuracy runs)")
    parser.add_argument("-t", "--threads", type=int, default=os.cpu_count(),
                        help="CPU threads (default: all cores)")
    parser.add_argument("--language", default="en", help="language (default: en)")
    parser.add_argument("--archive-dir", default=None,
                        help="move each successfully-transcribed source file here")
    parser.add_argument("--json", action="store_true",
                        help="emit one JSON result per file to stdout")
    args = parser.parse_args(argv)

    if args.out_dir:
        os.makedirs(args.out_dir, exist_ok=True)

    transcriber = Transcriber(args.model, args.threads, args.language)
    ok = failed = 0
    failures = []
    n = len(args.files)
    verbose = not args.json

    if verbose:
        log(f"Loading model '{args.model}' (first file also loads weights)...")

    for i, path in enumerate(args.files, 1):
        if verbose:
            log(f"  [{i}/{n}] {Path(path).name}")
        r = process_one(path, transcriber, args.out_dir, args.archive_dir, verbose)
        if r["status"] == "ok":
            ok += 1
        else:
            failed += 1
            failures.append((r["input"], r["error"]))
        emit(r, args.json)

    if not args.json:
        log(f"\nDone: {ok} ok, {failed} failed.")
        for inp, err in failures:
            log(f"  FAIL  {inp}: {err}")
    return 1 if failed else 0


def emit(r, as_json):
    if as_json:
        sys.stdout.write(json.dumps(r) + "\n")
        sys.stdout.flush()
        return
    if r["status"] == "ok":
        log(f"        ok -> {Path(r['output']).name} "
            f"({r['words']} words, {r['elapsedMs'] / 1000:.0f}s)")
    else:
        log(f"        FAIL: {r['error']}")


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


if __name__ == "__main__":
    sys.exit(main())
