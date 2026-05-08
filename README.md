# DS2 → MP3 Batch Converter

Two ways to convert Olympus `.ds2` / `.dss` dictation recordings to MP3:

1. **`ds2-convert` CLI** — headless Node tool for batch processing on a server.
2. **Browser app** — drag-and-drop static page for ad-hoc conversion.

Both share the same WASM decoder + JS MP3 encoder, so output is identical.
Audio never leaves your machine.

## CLI quick start

```bash
npm install        # install deps
npm link           # install ds2-convert globally (once)

ds2-convert recordings/*.ds2
ds2-convert -b 96 -o /var/transcripts/mp3 recordings/*.ds2
DS2_PASSWORD="$(cat secret.txt)" ds2-convert encrypted/*.ds2
ds2-convert --json --quiet *.ds2 > results.jsonl
```

Run `ds2-convert --help` for full options. Exit code is 0 if all conversions
succeed, 1 otherwise — safe to chain in shell pipelines.

## Browser app

## Features

- **Drag-and-drop or click** to add multiple files at once.
- **Per-file status**: pending → decoding → encoding → done, or failed with reason.
- **Format auto-detection** (DSS / DS2 SP / DS2 QP) with native sample-rate handling.
- **Encrypted DS2** support via password prompt or shared default password.
- **MP3 bitrate selector** (32–128 kbps; speech defaults to 64).
- **Per-file MP3 download**, or **download all as ZIP**.
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
cli/convert.mjs   headless CLI (registered as `ds2-convert`)
index.html        browser app shell
app.js            browser entry: drop/inspect/decode/encode flow
styles.css
vendor/dss-codec/ vendored WASM decoder (MIT, hirparak/dss-codec)
vendor/lamejs/    vendored MP3 encoder (LGPL, zhuker/lamejs)
vendor/jszip/     vendored ZIP packager (MIT/GPLv3)
scripts/          Node smoke test
package.json      pinned deps + bin entry for ds2-convert
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
