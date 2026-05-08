// Node-side smoke test: replicates the browser app's decode → MP3 pipeline.
// Validates the codec + encoder + framing logic without needing a browser.
import { readFile, writeFile } from "node:fs/promises";
import { decode, inspect } from "dss-codec";
import lamejs from "@breezystack/lamejs";

const inputPath = process.argv[2];
const bitrate = parseInt(process.argv[3] ?? "64", 10);
if (!inputPath) {
  console.error("usage: node node-smoke-test.mjs <input.ds2> [bitrate]");
  process.exit(2);
}

const bytes = new Uint8Array(await readFile(inputPath));

const ins = inspect(bytes.subarray(0, Math.min(bytes.length, 4096)));
console.log("inspect:", {
  format: ins.format,
  encryption: ins.encryption,
  nativeRate: ins.nativeRate,
});
ins.free();

const result = decode(bytes);
const pcm = result.samples.slice();
const sampleRate = result.nativeRate;
const format = result.format;
result.free();

console.log("decoded:", {
  format,
  samples: pcm.length,
  duration_s: (pcm.length / sampleRate).toFixed(2),
  rms: rms(pcm).toFixed(3),
  peak: Math.max(...pcm.slice(0, 100000).map(Math.abs)).toFixed(3),
});

const i16 = new Int16Array(pcm.length);
for (let i = 0; i < pcm.length; i++) {
  const x = Math.max(-1, Math.min(1, pcm[i]));
  i16[i] = (x * 32767) | 0;
}

const enc = new lamejs.Mp3Encoder(1, sampleRate, bitrate);
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

const outPath = inputPath.replace(/\.[^.]+$/, "") + `.${bitrate}kbps.mp3`;
await writeFile(outPath, merged);
console.log("encoded:", { path: outPath, bytes: merged.length, bitrate });

function rms(arr) {
  let s = 0;
  const n = arr.length;
  for (let i = 0; i < n; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / n);
}
