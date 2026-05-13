#!/usr/bin/env node
// DS2/DSS -> WAV/MP3 batch converter, headless-friendly.
//
// Usage:
//   ds2-convert [options] <files...>
// Options:
//   -f, --format <wav|mp3>   output format (default: wav, lossless)
//   -o, --out-dir <dir>      output directory (default: ./out)
//   -b, --bitrate <kbps>     MP3 bitrate, 16-320 (default: 64) — mp3 only
//   -p, --password <pwd>     password for encrypted DS2 files
//                            (or set DS2_PASSWORD env var)
//   --skip-existing          skip files whose output already exists
//   --json                   emit JSON results to stdout (one line per file)
//   --quiet                  suppress per-file output (only errors + summary)
//   -h, --help               show help
//
// Defaults to WAV because:
//   - DS2 is already a lossy ~28 kbps codec; another lossy step (MP3) compounds
//     artifacts that hurt speech-to-text accuracy.
//   - ElevenLabs Scribe v2 accepts WAV directly and recommends uncompressed PCM.
//   - 16 kHz mono WAV is ~115 MB/hour — well under ElevenLabs's 3 GB / 10 hour limit.

import { parseArgs } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { decode, decodeWithPassword, inspect } from "dss-codec";
import lamejs from "@breezystack/lamejs";

const HELP = `\
ds2-convert: batch convert Olympus .ds2 / .dss files to WAV or MP3

Usage:
  ds2-convert [options] <files...>

Options:
  -f, --format <wav|mp3>   output format (default: wav)
  -o, --out-dir <dir>      output directory (default: ./out)
  -b, --bitrate <kbps>     MP3 bitrate, 16-320 (default: 64) — mp3 only
  -p, --password <pwd>     password for encrypted DS2 files
                           (or set DS2_PASSWORD env var)
      --skip-existing      skip files whose output already exists
      --json               emit JSON results to stdout (one line per file)
      --quiet              suppress per-file output
  -h, --help               show help

WAV is the default because the DS2 codec is already lossy; MP3 adds a
second lossy step that hurts speech-to-text accuracy. Use MP3 only when
file size matters (archive, email, etc.).

Examples:
  ds2-convert recordings/*.ds2
  ds2-convert -f mp3 -b 96 -o /var/archive recordings/*.ds2
  DS2_PASSWORD="$(cat secret.txt)" ds2-convert encrypted/*.ds2
  ds2-convert --json --quiet *.ds2 > results.jsonl
`;

const args = parseCli();
if (args.help || args.positionals.length === 0) {
  process.stdout.write(HELP);
  process.exit(args.help ? 0 : 1);
}

const outDir = resolve(args.outDir);
await mkdir(outDir, { recursive: true });

const summary = {
  total: args.positionals.length,
  ok: 0,
  failed: 0,
  skipped: 0,
  totalDurationSec: 0,
  totalOutputBytes: 0,
  failures: [],
};

const password = args.password ?? process.env.DS2_PASSWORD ?? null;

for (const inputPath of args.positionals) {
  await processOne(inputPath);
}

if (!args.json) {
  log(
    `\nDone: ${summary.ok} ok, ${summary.failed} failed, ${summary.skipped} skipped, ` +
      `${summary.totalDurationSec.toFixed(1)}s audio -> ${formatBytes(summary.totalOutputBytes)}`,
  );
  if (summary.failures.length > 0) {
    log("Failures:");
    for (const f of summary.failures) log(`  ${f.input}: ${f.error}`);
  }
}
process.exit(summary.failed > 0 ? 1 : 0);

async function processOne(inputPath) {
  const inputAbs = resolve(inputPath);
  const baseName = basename(inputPath, extname(inputPath));
  const outputPath = join(outDir, `${baseName}.${args.format}`);
  const start = performance.now();

  let result = {
    input: inputPath,
    output: outputPath,
    status: "pending",
    durationSec: null,
    inputBytes: null,
    outputBytes: null,
    format: null,
    encryption: null,
    encoding: args.format,
    elapsedMs: null,
    error: null,
    skippedPrefixBytes: 0,
  };

  try {
    const st = await stat(inputAbs);
    result.inputBytes = st.size;

    if (args.skipExisting) {
      const existing = await stat(outputPath).catch(() => null);
      if (existing) {
        result.status = "skipped";
        summary.skipped++;
        emit(result);
        return;
      }
    }

    const rawBytes = new Uint8Array(await readFile(inputAbs));
    // Tolerate a short preamble of garbage bytes before the DS2/DSS magic.
    // The Olympus DS-5000 firmware (v1.08, 2012) occasionally writes 1-2 bytes
    // of uninitialized DMA buffer ahead of `\x03ds2` / `\x02dss` on file close.
    // The upstream codec (hirparak/dss-codec) requires the magic at offset 0
    // and rejects the file with "unsupported format type: <byte0>" otherwise.
    const { bytes, skippedPrefixBytes } = stripPreamble(rawBytes);
    if (skippedPrefixBytes > 0) result.skippedPrefixBytes = skippedPrefixBytes;
    const ins = inspect(bytes.subarray(0, Math.min(bytes.length, 4096)));
    result.format = ins.format;
    result.encryption = ins.encryption;
    const isEncrypted = ins.encryption && ins.encryption !== "none";
    ins.free();

    if (isEncrypted && !password) {
      throw new Error(
        `encrypted (${result.encryption}) — pass --password or set DS2_PASSWORD`,
      );
    }

    const decodeResult = isEncrypted
      ? decodeWithPassword(bytes, new TextEncoder().encode(password))
      : decode(bytes);

    let pcm, sampleRate;
    try {
      pcm = decodeResult.samples.slice();
      sampleRate = decodeResult.nativeRate;
    } finally {
      decodeResult.free();
    }

    result.durationSec = pcm.length / sampleRate;
    summary.totalDurationSec += result.durationSec;

    const outBytes = args.format === "wav"
      ? encodeWav(pcm, sampleRate)
      : encodeMp3(pcm, sampleRate, args.bitrate);
    await writeFile(outputPath, outBytes);

    result.outputBytes = outBytes.length;
    result.elapsedMs = Math.round(performance.now() - start);
    result.status = "ok";
    summary.ok++;
    summary.totalOutputBytes += outBytes.length;
    emit(result);
  } catch (err) {
    result.status = "failed";
    result.error = err && err.message ? err.message : String(err);
    result.elapsedMs = Math.round(performance.now() - start);
    summary.failed++;
    summary.failures.push({ input: inputPath, error: result.error });
    emit(result);
  }
}

function emit(r) {
  if (args.json) {
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (args.quiet && r.status !== "failed") return;
  if (r.status === "ok") {
    const skipNote = r.skippedPrefixBytes
      ? ` [skipped ${r.skippedPrefixBytes}B preamble]`
      : "";
    log(
      `  ok    ${r.input}  ${r.format} ${r.durationSec.toFixed(1)}s -> ${basename(r.output)} (${formatBytes(r.outputBytes)}, ${r.elapsedMs}ms)${skipNote}`,
    );
  } else if (r.status === "skipped") {
    log(`  skip  ${r.input}  (output exists)`);
  } else {
    log(`  FAIL  ${r.input}  ${r.error}`);
  }
}

// Scan up to 8 leading bytes for the DS2 (\x03ds2) or DSS (\x02dss / \x03dss)
// magic. If found at offset > 0, return the trimmed view; otherwise return the
// original bytes unchanged and let the codec produce its normal error.
function stripPreamble(bytes) {
  const MAX_PREAMBLE = 8;
  const limit = Math.min(bytes.length - 4, MAX_PREAMBLE);
  for (let off = 0; off <= limit; off++) {
    const b0 = bytes[off];
    const b1 = bytes[off + 1];
    const b2 = bytes[off + 2];
    const b3 = bytes[off + 3];
    // \x03ds2  (0x03 0x64 0x73 0x32) — DS2
    // \x02dss or \x03dss (0x02|0x03 0x64 0x73 0x73) — DSS Classic / Pro
    if (b1 === 0x64 && b2 === 0x73 && (b3 === 0x32 || b3 === 0x73)) {
      if ((b3 === 0x32 && b0 === 0x03) || (b3 === 0x73 && (b0 === 0x02 || b0 === 0x03))) {
        return { bytes: off === 0 ? bytes : bytes.subarray(off), skippedPrefixBytes: off };
      }
    }
  }
  return { bytes, skippedPrefixBytes: 0 };
}

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    out[i] = (x * 32767) | 0;
  }
  return out;
}

function encodeWav(float32Pcm, sampleRate) {
  const i16 = floatToInt16(float32Pcm);
  const dataBytes = i16.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  // RIFF header
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  // fmt chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);            // chunk size
  view.setUint16(20, 1, true);             // PCM format
  view.setUint16(22, 1, true);             // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono 16-bit)
  view.setUint16(32, 2, true);             // block align
  view.setUint16(34, 16, true);            // bits per sample
  // data chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(i16);
  return new Uint8Array(buf);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeMp3(float32Pcm, sampleRate, kbps) {
  const enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  const i16 = floatToInt16(float32Pcm);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < i16.length; i += blockSize) {
    const c = i16.subarray(i, Math.min(i + blockSize, i16.length));
    const out = enc.encodeBuffer(c);
    if (out.length > 0) chunks.push(out);
  }
  const tail = enc.flush();
  if (tail.length > 0) chunks.push(tail);
  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.length;
  }
  return merged;
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        format: { type: "string", short: "f", default: "wav" },
        "out-dir": { type: "string", short: "o", default: "./out" },
        bitrate: { type: "string", short: "b", default: "64" },
        password: { type: "string", short: "p" },
        "skip-existing": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n`);
    process.stdout.write(HELP);
    process.exit(2);
  }
  const fmt = parsed.values.format.toLowerCase();
  if (fmt !== "wav" && fmt !== "mp3") {
    process.stderr.write(`error: --format must be wav or mp3 (got ${parsed.values.format})\n`);
    process.exit(2);
  }
  const bitrate = parseInt(parsed.values.bitrate, 10);
  if (!Number.isFinite(bitrate) || bitrate < 16 || bitrate > 320) {
    process.stderr.write(`error: bitrate must be 16-320 (got ${parsed.values.bitrate})\n`);
    process.exit(2);
  }
  return {
    format: fmt,
    outDir: parsed.values["out-dir"],
    bitrate,
    password: parsed.values.password,
    skipExisting: parsed.values["skip-existing"],
    json: parsed.values.json,
    quiet: parsed.values.quiet,
    help: parsed.values.help,
    positionals: parsed.positionals,
  };
}

function log(msg) {
  if (!args.json) process.stderr.write(msg + "\n");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
