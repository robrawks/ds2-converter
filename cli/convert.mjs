#!/usr/bin/env node
// DS2/DSS -> MP3 batch converter, headless-friendly.
//
// Usage:
//   ds2-convert [options] <files...>
// Options:
//   -o, --out-dir <dir>      output directory (default: ./mp3s)
//   -b, --bitrate <kbps>     MP3 bitrate, 16-320 (default: 64)
//   -p, --password <pwd>     password for encrypted DS2 files
//                            (or set DS2_PASSWORD env var)
//   --skip-existing          skip files whose output already exists
//   --json                   emit JSON results to stdout (one line per file)
//   --quiet                  suppress per-file output (only errors + summary)
//   -h, --help               show help

import { parseArgs } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { decode, decodeWithPassword, inspect } from "dss-codec";
import lamejs from "@breezystack/lamejs";

const HELP = `\
ds2-convert: batch convert Olympus .ds2 / .dss files to MP3

Usage:
  ds2-convert [options] <files...>

Options:
  -o, --out-dir <dir>     output directory (default: ./mp3s)
  -b, --bitrate <kbps>    MP3 bitrate, 16-320 (default: 64)
  -p, --password <pwd>    password for encrypted DS2 files
                          (or set DS2_PASSWORD env var)
      --skip-existing     skip files whose output already exists
      --json              emit JSON results to stdout (one line per file)
      --quiet             suppress per-file output
  -h, --help              show help

Examples:
  ds2-convert recordings/*.ds2
  ds2-convert -b 96 -o /var/transcripts/mp3 *.ds2
  DS2_PASSWORD=secret ds2-convert -p "$DS2_PASSWORD" encrypted/*.ds2
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
  const outputPath = join(outDir, `${baseName}.mp3`);
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
    elapsedMs: null,
    error: null,
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

    const bytes = new Uint8Array(await readFile(inputAbs));
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

    const mp3 = encodeMp3(pcm, sampleRate, args.bitrate);
    await writeFile(outputPath, mp3);

    result.outputBytes = mp3.length;
    result.elapsedMs = Math.round(performance.now() - start);
    result.status = "ok";
    summary.ok++;
    summary.totalOutputBytes += mp3.length;
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
    log(
      `  ok    ${r.input}  ${r.format} ${r.durationSec.toFixed(1)}s -> ${basename(r.output)} (${formatBytes(r.outputBytes)}, ${r.elapsedMs}ms)`,
    );
  } else if (r.status === "skipped") {
    log(`  skip  ${r.input}  (output exists)`);
  } else {
    log(`  FAIL  ${r.input}  ${r.error}`);
  }
}

function encodeMp3(float32Pcm, sampleRate, kbps) {
  const enc = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  const i16 = new Int16Array(float32Pcm.length);
  for (let i = 0; i < float32Pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, float32Pcm[i]));
    i16[i] = (x * 32767) | 0;
  }
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
        "out-dir": { type: "string", short: "o", default: "./mp3s" },
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
  const bitrate = parseInt(parsed.values.bitrate, 10);
  if (!Number.isFinite(bitrate) || bitrate < 16 || bitrate > 320) {
    process.stderr.write(`error: bitrate must be 16-320 (got ${parsed.values.bitrate})\n`);
    process.exit(2);
  }
  return {
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
