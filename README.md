# DS2 → WAV / MP3 / Text

Tools for working with Olympus `.ds2` / `.dss` dictation recordings:

1. **`ds2-convert` CLI** — headless Node tool: batch convert to WAV or MP3.
2. **Browser app** — drag-and-drop static page for ad-hoc conversion.
3. **`ds2-transcribe` CLI** — headless Python tool: convert *and* transcribe to
   plain text, **fully offline** (local Whisper, no API keys). See
   [Local transcription](#local-transcription-ds2-transcribe).

Everything runs locally — audio never leaves your machine.

**Defaults to WAV (lossless).** DS2 is already a lossy ~28 kbps codec; adding a
second lossy step (MP3) compounds artifacts that hurt speech-to-text accuracy.
For ElevenLabs Scribe v2 and similar STT services, send WAV directly. Use MP3
only when you specifically need small files for archive or email.

## CLI quick start

```bash
npm install        # install deps
npm link           # install ds2-convert globally (once)

ds2-convert recordings/*.ds2                         # WAV (default)
ds2-convert -f mp3 -b 96 -o /var/archive *.ds2       # MP3 96 kbps
DS2_PASSWORD="$(cat secret.txt)" ds2-convert encrypted/*.ds2
ds2-convert --json --quiet *.ds2 > results.jsonl
```

Run `ds2-convert --help` for full options. Exit code is 0 if all conversions
succeed, 1 otherwise — safe to chain in shell pipelines.

## Sending output to ElevenLabs Scribe v2

ElevenLabs Speech-to-Text accepts WAV, FLAC, MP3, OPUS, and others, with a
3 GB / 10-hour per-request limit. WAV at 16 kHz mono (the default this tool
produces) is ~115 MB/hour — easily within budget. Recommended:

```bash
ds2-convert recordings/*.ds2                            # produces ./out/*.wav
curl -X POST https://api.elevenlabs.io/v1/speech-to-text \
  -H "xi-api-key: $XI_API_KEY" \
  -F "model_id=scribe_v2" \
  -F "file=@./out/recording.wav"
```

## Local transcription (`ds2-transcribe`)

A fully-offline alternative to cloud STT: decode a `.ds2` / `.dss` (or `.wav`) and
transcribe it to plain text on your own machine with a local Whisper model. No API
keys, no uploads, no per-minute fees. Built for the headless VPS path.

Stack: [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2,
CPU, int8) running `base.en`, fed directly from the vendored pure-Python DS2/DSS
decoder — no intermediate audio file.

### One-time setup

```bash
bash scripts/setup-whisper.sh          # venv + faster-whisper + download base.en
# optional: put it on PATH
ln -s "$PWD/bin/ds2-transcribe" ~/.local/bin/ds2-transcribe
```

The setup downloads the model once (~140 MB) into `transcribe/models/`; every run
afterwards is fully offline (`local_files_only=True`).

### Use

```bash
ds2-transcribe recording.ds2                  # writes recording.txt next to it
ds2-transcribe -o transcripts/ *.ds2          # all transcripts into one dir
ds2-transcribe --json *.ds2 > results.jsonl   # machine-readable, one line per file
```

Options: `-o/--out-dir`, `-m/--model` (default `base.en`), `-t/--threads`
(default: all cores), `--language` (default `en`), `--json`. Exit code 1 if any
file failed; the batch continues past failures.

On a 4-vCPU CPU-only VPS, `base.en` runs ~3–4× realtime (a 37 s clip ≈ 10 s).
Encrypted DS2 (`\x03enc`) is out of scope for v1 — it errors clearly; convert/decrypt
it elsewhere first. The decoder tolerates the 1–2 byte DMA preamble some DS-5000
firmware writes before the magic (same fix as `ds2-convert`).

### Cloud vs local

Use **`ds2-convert` → ElevenLabs** (above) when you want ElevenLabs' accuracy and
don't mind the upload + per-minute cost. Use **`ds2-transcribe`** when you want
everything to stay on your box with zero external dependencies.

## Browser app

## Features

- **Drag-and-drop or click** to add multiple files at once.
- **Per-file status**: pending → decoding → encoding → done, or failed with reason.
- **Format auto-detection** (DSS / DS2 SP / DS2 QP) with native sample-rate handling.
- **Encrypted DS2** support via password prompt or shared default password.
- **WAV (default, lossless) or MP3** with bitrate selector (32–128 kbps).
- **Per-file download**, or **download all as ZIP**.
- **Zero build step.** Static HTML + JS + WASM, served by any web server.

## Usage

### Local (development)

```bash
python3 -m http.server 8765
# then open http://127.0.0.1:8765/
```

Or any other static file server (Caddy, nginx, `npx serve`, etc.).

### VPS deployment

Copy the entire directory (everything except `node_modules/` — see
`.gitignore`) onto your VPS document root:

```bash
rsync -av --exclude=node_modules --exclude=.git ./ vps:/var/www/ds2-converter/
```

Point any web server at it. No build step, no server-side code, no database.
Just static files. WASM works over plain HTTP for local development; for any
production deployment use HTTPS so the browser doesn't downgrade WASM
streaming compilation.

## Smoke testing the pipeline

```bash
npm install
node scripts/node-smoke-test.mjs path/to/recording.ds2 64
```

Decodes via the same Node entrypoint of `dss-codec`, encodes via `lamejs`,
writes `recording.64kbps.mp3`. Confirms the pipeline end-to-end without
needing a browser.

## File layout

```
cli/convert.mjs         headless WAV/MP3 CLI (`ds2-convert`)
index.html              browser app shell
app.js                  browser entry: drop/inspect/decode/encode flow
styles.css
vendor/dss-codec/       vendored WASM decoder (MIT, hirparak/dss-codec)
vendor/lamejs/          vendored MP3 encoder (LGPL, zhuker/lamejs)
vendor/jszip/           vendored ZIP packager (MIT/GPLv3)
bin/ds2-transcribe      launcher for the transcription CLI
transcribe/ds2_transcribe.py   local-Whisper transcription CLI
transcribe/vendor/      vendored pure-Python DS2/DSS decoder (patched) + codebooks
transcribe/requirements.txt    faster-whisper, scipy, numpy
transcribe/.venv,models/       local venv + downloaded model (gitignored)
scripts/setup-whisper.sh       one-time venv + model setup
scripts/node-smoke-test.mjs    Node decode→MP3 smoke test
package.json            pinned deps + bin entry for ds2-convert
```

## Roadmap (Phase 2)

- **ElevenLabs integration.** Drop encoded MP3 directly into a transcription
  job. Needs a tiny server-side proxy on the VPS to keep the API key off the
  client. Likely a 50-line Node/Bun handler.
- **Persistent transcript log** that pairs original DS2 metadata (timestamp,
  device serial) with the resulting transcript text.

## Credits

- **Codec reverse engineering**: [Kieran Hirpara](https://github.com/hirparak/dss-codec)
  (MIT, Feb 2026) — the work that made open-source DS2 decoding possible at all.
- **WASM build**: [Gaspard Petit](https://github.com/gaspardpetit/dss-codec-wasm) (MIT).
- **MP3 encoder**: [lamejs](https://github.com/zhuker/lamejs) (LGPL),
  [Breezy Stack fork](https://github.com/breezystack/lamejs) (active maintenance).
- **Background**: [FFmpeg trac #6091](https://trac.ffmpeg.org/ticket/6091) had the
  DS2 codec listed as unimplemented from 2017 to early 2026.

## License

MIT.
