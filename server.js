const express = require("express");
const path = require("path");
const fs = require("fs");
const config = require("./config.json");

if (!fs.existsSync(path.dirname(config.destination)) && !fs.existsSync(config.destination)) {
  console.error(`\nDestination path does not look mounted: ${config.destination}`);
  console.error(`Edit config.json "destination" to point at your SSD, then restart.\n`);
  process.exit(1);
}

// The external drive backing `config.destination` has intermittently dropped
// mid-run during the full 63,650-doc load (twice so far), and any write that
// lands in that gap is otherwise an uncaught exception that kills this whole
// long-running process — losing in-memory progress for every chunk still in
// flight, not just the one that hit the bad write. Log and keep going instead;
// per-chunk errors already have their own handling and get marked "failed".
process.on("uncaughtException", (err) => {
  console.error(`uncaughtException (server staying up): ${err.stack || err.message}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`unhandledRejection (server staying up): ${err && err.stack || err}`);
});

const { db, bucket } = require("./lib/firebase");
const { buildChunkPlan } = require("./lib/chunks");
const { buildLoadChunkPlan } = require("./lib/loadChunks");
const { loadState, saveState } = require("./lib/state");
const { processChunk, dependenciesMet, PauseSignal, runWithConcurrency } = require("./lib/downloader");
const { transform } = require("./lib/transform");
const { processLoadChunk, PauseSignal: LoadPauseSignal } = require("./lib/loader");

// Most chunks (one per month) are fully independent of each other, so there's
// no reason to process them strictly one at a time — only the two trailing
// chunks (old-certificates-meta, legacy-only-images) have real dependencies,
// handled below via dependenciesMet().
// Lowered from 3 for the incremental run: the destination is an exFAT
// volume mounted through fskit, which wedged a whole server process in
// uninterruptible I/O under the original 3 x 16 = 48 concurrent writes.
// Raise again if the destination moves to an APFS/HFS+ disk.
const CHUNK_CONCURRENCY = 1;
// Load writes into real production Mongo/R2. Small-scale testing (a few
// months, then 10 individual certs) is done and verified — now doing the
// full 63,650-doc run, so concurrency is raised from the original cautious
// 2 to cut wall-clock time; the real bottleneck is this laptop's network
// round-trips to Mongo/R2, not target capacity (db-s-1vcpu-1gb Mongo + R2
// both handle far more parallel writes than this comfortably).
const LOAD_CHUNK_CONCURRENCY = 6;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────── Extract (existing) ────────────────────────────

const chunks = buildChunkPlan();
const state = loadState(config.destination, chunks);

let running = false;

const SPEED_WINDOW_MS = 15000;
let speedSamples = [];

function totalBytesDone() {
  return Object.values(state.chunks).reduce((sum, cs) => sum + (cs.bytesDone || 0), 0);
}

function recordSpeedSample() {
  const now = Date.now();
  speedSamples.push({ t: now, bytes: totalBytesDone() });
  const cutoff = now - SPEED_WINDOW_MS;
  while (speedSamples.length > 1 && speedSamples[0].t < cutoff) speedSamples.shift();
}

function currentSpeedBytesPerSec() {
  if (speedSamples.length < 2) return 0;
  const first = speedSamples[0];
  const last = speedSamples[speedSamples.length - 1];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
}

// Rough ETA: we don't know a not-yet-started chunk's real size until it's
// actually queried, so this extrapolates from the average size of chunks
// already completed that turned out to have real documents (ignoring the
// many trivially-empty pre-2025 months, which would otherwise drag the
// average down and make the estimate too optimistic). Good enough for a
// ballpark, not meant to be exact.
function estimateEtaSeconds(speedBytesPerSec) {
  const realDone = chunks
    .map((c) => state.chunks[c.id])
    .filter((cs) => cs.status === "done" && (cs.bytesDone || 0) > 0);
  if (realDone.length === 0 || speedBytesPerSec <= 0) return null;

  const avgBytesPerRealChunk = realDone.reduce((sum, cs) => sum + cs.bytesDone, 0) / realDone.length;

  let remainingBytes = 0;
  for (const c of chunks) {
    const cs = state.chunks[c.id];
    if (cs.status === "done") continue;
    if (cs.status === "in_progress") {
      remainingBytes += Math.max(avgBytesPerRealChunk - (cs.bytesDone || 0), 0);
    } else {
      remainingBytes += avgBytesPerRealChunk;
    }
  }

  return remainingBytes / speedBytesPerSec;
}

function onProgress(chunkId, patch, throttle) {
  Object.assign(state.chunks[chunkId], patch, { updatedAt: new Date().toISOString() });
  saveState(config.destination, state);
  recordSpeedSample();
  broadcast(!throttle);
}

function isPaused() {
  return state.paused;
}

// Picks the next eligible chunk and marks it in_progress synchronously (no
// await in between) so concurrent lanes can never both claim the same one —
// safe purely because JS runs this function body to completion in one tick.
function claimNextChunk() {
  for (const chunk of chunks) {
    const cs = state.chunks[chunk.id];
    if (cs.status !== "pending") continue;
    if (!dependenciesMet(chunk, chunks, state)) continue;
    cs.status = "in_progress";
    return chunk;
  }
  return null;
}

async function runQueue() {
  if (running) return;
  running = true;
  broadcast(true);

  async function lane() {
    while (!state.paused) {
      const chunk = claimNextChunk();
      if (!chunk) return; // nothing currently eligible; other lanes may still unblock more work
      onProgress(chunk.id, { status: "in_progress" }, false);
      try {
        await processChunk(chunk, { db, bucket, destination: config.destination, onProgress, isPaused, state });
      } catch (err) {
        if (err instanceof PauseSignal) {
          onProgress(chunk.id, { status: "pending" }, false);
        } else {
          onProgress(chunk.id, { status: "failed", error: err.message }, false);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: CHUNK_CONCURRENCY }, lane));

  running = false;
  broadcast(true);
}

// ────────────────────────────── Transform ───────────────────────────────

const reportPath = path.join(config.destination, "data", "transformed", "report.json");
let transformStatus = {
  running: false,
  error: null,
  report: fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null,
};

function runTransform() {
  if (transformStatus.running) return;
  transformStatus = { running: true, error: null, report: transformStatus.report };
  broadcast(true);
  // transform() is synchronous and does a fair amount of disk I/O over the
  // full dataset — run it off the main event-loop turn via setImmediate so
  // the "running" state actually reaches the client before it blocks.
  setImmediate(() => {
    try {
      const report = transform();
      transformStatus = { running: false, error: null, report };
    } catch (err) {
      transformStatus = { running: false, error: err.message, report: transformStatus.report };
    }
    broadcast(true);
  });
}

// ────────────────────────────────  Load  ────────────────────────────────

let loadChunks = buildLoadChunkPlan(config.destination);
let loadState_ = loadState(config.destination, loadChunks, "state-load.json");
let loadRunning = false;

const LOAD_SPEED_WINDOW_MS = 15000;
let loadSpeedSamples = [];

function totalLoadBytesDone() {
  return Object.values(loadState_.chunks).reduce((sum, cs) => sum + (cs.bytesDone || 0), 0);
}

function recordLoadSpeedSample() {
  const now = Date.now();
  loadSpeedSamples.push({ t: now, bytes: totalLoadBytesDone() });
  const cutoff = now - LOAD_SPEED_WINDOW_MS;
  while (loadSpeedSamples.length > 1 && loadSpeedSamples[0].t < cutoff) loadSpeedSamples.shift();
}

function currentLoadSpeedBytesPerSec() {
  if (loadSpeedSamples.length < 2) return 0;
  const first = loadSpeedSamples[0];
  const last = loadSpeedSamples[loadSpeedSamples.length - 1];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.bytes - first.bytes) / dt : 0;
}

function onLoadProgress(chunkId, patch, throttle) {
  Object.assign(loadState_.chunks[chunkId], patch, { updatedAt: new Date().toISOString() });
  saveState(config.destination, loadState_, "state-load.json");
  recordLoadSpeedSample();
  broadcast(!throttle);
}

function isLoadPaused() {
  return loadState_.paused;
}

function refreshLoadChunkPlan() {
  loadChunks = buildLoadChunkPlan(config.destination);
  loadState_ = loadState(config.destination, loadChunks, "state-load.json");
}

function claimNextLoadChunk() {
  for (const chunk of loadChunks) {
    const cs = loadState_.chunks[chunk.id];
    if (!cs || cs.status !== "pending") continue;
    if (!dependenciesMet(chunk, loadChunks, loadState_)) continue;
    cs.status = "in_progress";
    return chunk;
  }
  return null;
}

async function runLoadQueue() {
  if (loadRunning) return;
  loadRunning = true;
  broadcast(true);

  async function lane() {
    while (!loadState_.paused) {
      const chunk = claimNextLoadChunk();
      if (!chunk) return;
      onLoadProgress(chunk.id, { status: "in_progress" }, false);
      try {
        await processLoadChunk(chunk, {
          destination: config.destination,
          onProgress: onLoadProgress,
          isPaused: isLoadPaused,
          state: loadState_,
        });
      } catch (err) {
        if (err instanceof LoadPauseSignal) {
          onLoadProgress(chunk.id, { status: "pending" }, false);
        } else {
          onLoadProgress(chunk.id, { status: "failed", error: err.message }, false);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: LOAD_CHUNK_CONCURRENCY }, lane));

  loadRunning = false;
  broadcast(true);
}

// ──────────────────────────────  SSE / API  ──────────────────────────────

let sseClients = [];
let lastBroadcastAt = 0;

function buildStatePayload() {
  const extractSpeed = currentSpeedBytesPerSec();
  const loadSpeed = currentLoadSpeedBytesPerSec();
  return {
    extract: {
      chunks,
      state,
      speedBytesPerSec: extractSpeed,
      etaSeconds: estimateEtaSeconds(extractSpeed),
    },
    transform: transformStatus,
    load: {
      chunks: loadChunks,
      state: loadState_,
      speedBytesPerSec: loadSpeed,
    },
  };
}

function broadcast(force) {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 500) return;
  lastBroadcastAt = now;
  const payload = `data: ${JSON.stringify(buildStatePayload())}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

setInterval(() => {
  recordSpeedSample();
  recordLoadSpeedSample();
  broadcast(true);
}, 1000);

app.get("/api/state", (req, res) => res.json(buildStatePayload()));

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  sseClients.push(res);
  res.write(`data: ${JSON.stringify(buildStatePayload())}\n\n`);
  req.on("close", () => {
    sseClients = sseClients.filter((c) => c !== res);
  });
});

// Extract endpoints (unchanged)
app.post("/api/start-all", (req, res) => {
  state.paused = false;
  saveState(config.destination, state);
  runQueue();
  res.json({ ok: true });
});

app.post("/api/pause", (req, res) => {
  state.paused = true;
  saveState(config.destination, state);
  broadcast(true);
  res.json({ ok: true });
});

app.post("/api/resume", (req, res) => {
  state.paused = false;
  saveState(config.destination, state);
  runQueue();
  res.json({ ok: true });
});

app.post("/api/chunks/:id/retry", (req, res) => {
  const cs = state.chunks[req.params.id];
  if (!cs) return res.status(404).json({ ok: false, error: "unknown chunk" });
  cs.status = "pending";
  cs.error = null;
  saveState(config.destination, state);
  runQueue();
  res.json({ ok: true });
});

// Transform endpoints
app.post("/api/transform/run", (req, res) => {
  runTransform();
  res.json({ ok: true });
});

// Load endpoints
app.post("/api/load/start-all", (req, res) => {
  refreshLoadChunkPlan();
  loadState_.paused = false;
  saveState(config.destination, loadState_, "state-load.json");
  runLoadQueue();
  res.json({ ok: true });
});

app.post("/api/load/pause", (req, res) => {
  loadState_.paused = true;
  saveState(config.destination, loadState_, "state-load.json");
  broadcast(true);
  res.json({ ok: true });
});

app.post("/api/load/resume", (req, res) => {
  loadState_.paused = false;
  saveState(config.destination, loadState_, "state-load.json");
  runLoadQueue();
  res.json({ ok: true });
});

app.post("/api/load/chunks/:id/retry", (req, res) => {
  const cs = loadState_.chunks[req.params.id];
  if (!cs) return res.status(404).json({ ok: false, error: "unknown chunk" });
  cs.status = "pending";
  cs.error = null;
  saveState(config.destination, loadState_, "state-load.json");
  runLoadQueue();
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`\nGAC migration dashboard: http://localhost:${config.port}`);
  console.log(`Destination: ${config.destination}\n`);
});
