import init, { decode, decodeWithPassword, inspect } from "./vendor/dss-codec/dss_codec_wasm.js";

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const fileRows = document.getElementById("file-rows");
const convertAllBtn = document.getElementById("convert-all");
const downloadZipBtn = document.getElementById("download-zip");
const clearAllBtn = document.getElementById("clear-all");
const formatSelect = document.getElementById("format");
const bitrateSelect = document.getElementById("bitrate");
const bitrateSetting = document.getElementById("bitrate-setting");
const defaultPasswordInput = document.getElementById("default-password");
const globalStatus = document.getElementById("global-status");

formatSelect.addEventListener("change", syncBitrateVisibility);
syncBitrateVisibility();
function syncBitrateVisibility() {
  bitrateSetting.hidden = formatSelect.value !== "mp3";
}

const state = {
  ready: false,
  jobs: new Map(),
  busy: false,
};

const Lame = window.lamejs;
const Zip = window.JSZip;

(async function boot() {
  try {
    await init();
    state.ready = true;
    setStatus("Drop DS2/DSS files to begin.");
  } catch (err) {
    setStatus(`Failed to load WASM: ${formatError(err)}`, "error");
  }
})();

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  addFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

convertAllBtn.addEventListener("click", convertAll);
downloadZipBtn.addEventListener("click", downloadZip);
clearAllBtn.addEventListener("click", clearAll);

function addFiles(files) {
  if (!state.ready) {
    setStatus("WASM still loading. Try again in a moment.", "error");
    return;
  }
  const accepted = files.filter((f) =>
    /\.(ds2|dss)$/i.test(f.name) || f.size > 0
  );
  for (const file of accepted) {
    const id = crypto.randomUUID();
    const job = {
      id,
      file,
      name: file.name,
      size: file.size,
      status: "pending",
      format: null,
      encryption: null,
      sampleRate: null,
      durationSec: null,
      outBytes: null,
      outUrl: null,
      outExt: null,
      outMime: null,
      error: null,
    };
    state.jobs.set(id, job);
    insertRow(job);
    inspectAsync(job);
  }
  refreshControls();
}

function clearAll() {
  for (const job of state.jobs.values()) {
    if (job.outUrl) URL.revokeObjectURL(job.outUrl);
  }
  state.jobs.clear();
  fileRows.innerHTML = '<tr class="empty"><td colspan="5">No files yet.</td></tr>';
  refreshControls();
  setStatus("Cleared.");
}

async function inspectAsync(job) {
  try {
    const head = new Uint8Array(
      await job.file.slice(0, Math.min(job.file.size, 4096)).arrayBuffer(),
    );
    const ins = inspect(head);
    job.format = ins.format;
    job.encryption = ins.encryption;
    job.sampleRate = ins.nativeRate;
    ins.free();
    setRow(job);
  } catch (err) {
    job.status = "failed";
    job.error = `inspect: ${formatError(err)}`;
    setRow(job);
  }
}

async function convertAll() {
  if (state.busy) return;
  state.busy = true;
  refreshControls();
  const format = formatSelect.value;
  const bitrate = parseInt(bitrateSelect.value, 10);
  const defaultPwd = defaultPasswordInput.value || "";
  const todo = [...state.jobs.values()].filter((j) =>
    j.status === "pending" || j.status === "failed"
  );
  let done = 0;
  for (const job of todo) {
    setStatus(`Converting ${++done}/${todo.length}: ${job.name}`);
    try {
      await convertOne(job, format, bitrate, defaultPwd);
    } catch (err) {
      job.status = "failed";
      job.error = formatError(err);
      setRow(job);
    }
  }
  state.busy = false;
  refreshControls();
  const ok = [...state.jobs.values()].filter((j) => j.status === "done").length;
  const fail = [...state.jobs.values()].filter((j) => j.status === "failed").length;
  setStatus(`Done. ${ok} converted, ${fail} failed.`);
}

async function convertOne(job, format, bitrate, defaultPwd) {
  job.status = "decoding";
  job.error = null;
  setRow(job);

  const bytes = new Uint8Array(await job.file.arrayBuffer());
  let result;
  try {
    if (job.encryption && job.encryption !== "none") {
      const pwd = await pickPassword(job, defaultPwd);
      const pwdBytes = new TextEncoder().encode(pwd);
      result = decodeWithPassword(bytes, pwdBytes);
    } else {
      result = decode(bytes);
    }
  } catch (err) {
    throw new Error(`decode: ${formatError(err)}`);
  }

  let pcm, sampleRate;
  try {
    pcm = result.samples.slice();
    sampleRate = result.nativeRate;
    job.format = result.format;
    job.sampleRate = sampleRate;
    job.durationSec = pcm.length / sampleRate;
  } finally {
    result.free();
  }

  job.status = "encoding";
  setRow(job);
  await Promise.resolve();

  if (format === "wav") {
    job.outBytes = encodeWav(pcm, sampleRate);
    job.outExt = "wav";
    job.outMime = "audio/wav";
  } else {
    job.outBytes = encodeMp3(pcm, sampleRate, bitrate);
    job.outExt = "mp3";
    job.outMime = "audio/mpeg";
  }
  if (job.outUrl) URL.revokeObjectURL(job.outUrl);
  job.outUrl = URL.createObjectURL(new Blob([job.outBytes], { type: job.outMime }));
  job.status = "done";
  setRow(job);
}

function encodeWav(float32Pcm, sampleRate) {
  const i16 = floatToInt16(float32Pcm);
  const dataBytes = i16.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(i16);
  return new Uint8Array(buf);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function encodeMp3(float32Pcm, sampleRate, kbps) {
  const encoder = new Lame.Mp3Encoder(1, sampleRate, kbps);
  const samples = floatToInt16(float32Pcm);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    const chunk = samples.subarray(i, Math.min(i + blockSize, samples.length));
    const out = encoder.encodeBuffer(chunk);
    if (out.length > 0) chunks.push(out);
  }
  const tail = encoder.flush();
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

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    out[i] = (x * 32767) | 0;
  }
  return out;
}

async function pickPassword(job, fallback) {
  if (fallback) return fallback;
  return new Promise((resolve) => {
    const pwd = window.prompt(
      `"${job.name}" is encrypted (${job.encryption}). Enter password:`,
      "",
    );
    resolve(pwd ?? "");
  });
}

async function downloadZip() {
  const ready = [...state.jobs.values()].filter((j) => j.status === "done");
  if (ready.length === 0) return;
  setStatus("Building ZIP…");
  const zip = new Zip();
  for (const job of ready) {
    const base = job.name.replace(/\.[^.]+$/, "");
    zip.file(`${base}.${job.outExt}`, job.outBytes);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ds2-converted-${nowStamp()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`ZIP downloaded (${ready.length} files).`);
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function insertRow(job) {
  const empty = fileRows.querySelector("tr.empty");
  if (empty) empty.remove();
  const tr = document.createElement("tr");
  tr.dataset.id = job.id;
  tr.innerHTML = `
    <td class="cell-name"></td>
    <td class="cell-format"></td>
    <td class="cell-duration"></td>
    <td class="cell-status"></td>
    <td class="cell-output"></td>
  `;
  fileRows.appendChild(tr);
  setRow(job);
}

function setRow(job) {
  const tr = fileRows.querySelector(`tr[data-id="${job.id}"]`);
  if (!tr) return;
  tr.querySelector(".cell-name").textContent = job.name;
  const fmt = job.format
    ? `${job.format}${job.encryption && job.encryption !== "none" ? " 🔒" : ""}`
    : "—";
  tr.querySelector(".cell-format").textContent = fmt;
  tr.querySelector(".cell-duration").textContent = job.durationSec
    ? `${job.durationSec.toFixed(1)}s`
    : "—";
  const statusCell = tr.querySelector(".cell-status");
  statusCell.className = `cell-status status-${job.status}`;
  statusCell.textContent = job.error
    ? `failed: ${job.error}`
    : job.status;
  const out = tr.querySelector(".cell-output");
  if (job.status === "done" && job.outUrl) {
    const base = job.name.replace(/\.[^.]+$/, "");
    const label = (job.outExt || "").toUpperCase();
    out.innerHTML = `<a href="${job.outUrl}" download="${base}.${job.outExt}">Download ${label}</a>`;
  } else {
    out.textContent = "—";
  }
  refreshControls();
}

function refreshControls() {
  const jobs = [...state.jobs.values()];
  const anyPending = jobs.some(
    (j) => j.status === "pending" || j.status === "failed",
  );
  const anyDone = jobs.some((j) => j.status === "done");
  convertAllBtn.disabled = !state.ready || state.busy || !anyPending;
  downloadZipBtn.disabled = !anyDone || state.busy;
  clearAllBtn.disabled = jobs.length === 0 || state.busy;
}

function setStatus(msg, kind = "") {
  globalStatus.textContent = msg;
  globalStatus.className = `status ${kind}`;
}

function formatError(err) {
  if (err && typeof err === "object" && "message" in err) return err.message;
  return String(err);
}
