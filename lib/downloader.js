const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class PauseSignal extends Error {}

// Each file download is a separate network round-trip; doing them one at a
// time leaves most of the wall-clock time spent waiting on latency rather
// than moving bytes. Running a fixed number of them concurrently is what
// actually saturates the connection, especially from a well-connected host
// (e.g. an EC2 instance) talking to Google Cloud Storage.
// See CHUNK_CONCURRENCY in server.js — kept low so the exFAT/fskit mount
// is not asked for dozens of parallel small-file writes at once.
const FILE_CONCURRENCY = 12;

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function lane() {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// Downloads a bucket file to disk. Writes to a .part file first and only
// renames to the final name on success, so "final file exists" reliably means
// "download completed" — resuming after a crash just means checking for the
// final filename, no extra metadata/size-comparison API calls needed.
// One readdir per directory, cached, instead of an existsSync per file.
//
// The destination lives on exFAT, which has no directory index: every lookup
// is a linear scan of the directory. files/images holds hundreds of thousands
// of entries, and a single existsSync there was measured at 4857ms against
// 0.03ms on APFS. Because that call is synchronous and on the main thread, it
// also stalled all download workers behind it — 12-way concurrency collapsed
// to roughly one file per five seconds, which is exactly the ~20KB/s the
// migration was achieving while the network could do 676KB/s.
const dirIndex = new Map();

function dirEntries(dir) {
  let set = dirIndex.get(dir);
  if (!set) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      set = new Set(fs.readdirSync(dir));
    } catch {
      set = new Set();
    }
    dirIndex.set(dir, set);
  }
  return set;
}

function haveFile(localPath) {
  return dirEntries(path.dirname(localPath)).has(path.basename(localPath));
}

function noteFile(localPath) {
  dirEntries(path.dirname(localPath)).add(path.basename(localPath));
}

async function downloadFileIfNeeded(bucket, storagePath, localPath) {
  if (haveFile(localPath)) return { skipped: true };
  // Different chunks (e.g. brand-logos and legacy-only-images) can reference
  // the exact same shared file (a reused demo/default logo) and race to
  // download it concurrently. A shared ".part" name meant one lane could
  // rename it away right as another was about to stat/rename the same path
  // — ENOENT. A per-call random suffix avoids two lanes fighting over one
  // tmp file; the existsSync check right before renaming handles the other
  // half of the race (both finish downloading, only one should "win").
  const tmpPath = `${localPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  try {
    await bucket.file(storagePath).download({ destination: tmpPath });
  } catch (err) {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    if (err.code === 404) return { missing: true };
    throw err;
  }
  const stat = fs.statSync(tmpPath);
  if (haveFile(localPath)) {
    // Another concurrent call for the same storagePath already won.
    fs.unlinkSync(tmpPath);
    return { skipped: true };
  }
  try {
    fs.renameSync(tmpPath, localPath);
    noteFile(localPath);
  } catch (err) {
    if (haveFile(localPath)) {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      return { skipped: true };
    }
    throw err;
  }
  return { downloaded: true, bytes: stat.size };
}

// Firebase Admin's file.publicUrl() / makePublic() produces URLs like
// https://storage.googleapis.com/{bucket}/{path}. Some older helpers in the
// old codebase may instead produce the firebasestorage.googleapis.com
// /v0/b/{bucket}/o/{encodedPath}?alt=media form, so both are handled.
function extractStoragePath(url, bucketName) {
  if (!url || typeof url !== "string") return null;
  const directPrefix = `https://storage.googleapis.com/${bucketName}/`;
  if (url.startsWith(directPrefix)) {
    return decodeURIComponent(url.slice(directPrefix.length));
  }
  const match = url.match(/\/o\/([^?]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

async function paginateCollection(db, collectionName, pageSize, startAfterId) {
  let query = db.collection(collectionName).orderBy("__name__").limit(pageSize);
  if (startAfterId) {
    const cursorDoc = await db.collection(collectionName).doc(startAfterId).get();
    if (cursorDoc.exists) query = query.startAfter(cursorDoc);
  }
  return query.get();
}

async function processCertifiedDiamondsChunk(chunk, ctx) {
  const { db, bucket, destination, onProgress, isPaused, state } = ctx;
  const dataDir = path.join(destination, "data", "certified-diamonds");
  fs.mkdirSync(dataDir, { recursive: true });

  const cs = state.chunks[chunk.id];
  const pageSize = 1000;
  let cursor = cs.lastDocId;
  let pagesDone = cs.pagesDone || 0;
  let docCount = cs.docCount || 0;
  const bucketName = bucket.name;
  const seenFiles = new Set();
  let filesDone = cs.filesDone || 0;
  let bytesDone = cs.bytesDone || 0;

  while (true) {
    if (isPaused()) throw new PauseSignal();

    let query = db
      .collection("Certified Diamonds")
      .where("certificateNo", ">=", chunk.prefixStart)
      .where("certificateNo", "<", chunk.prefixEnd)
      .orderBy("certificateNo")
      .limit(pageSize);
    if (cursor) {
      const cursorDoc = await db.collection("Certified Diamonds").doc(cursor).get();
      if (cursorDoc.exists) query = query.startAfter(cursorDoc);
    }

    const snap = await query.get();
    if (snap.empty) break;

    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const pageFile = path.join(dataDir, `${chunk.id}__page-${String(pagesDone).padStart(4, "0")}.json`);
    fs.writeFileSync(pageFile, JSON.stringify(docs, null, 2));

    // Only imageUrl/logoUrl are the actual source photo/logo files. frontImageUrl/
    // backImageUrl point at auto-rendered oldCertificate/ card mirrors used by the
    // old QR-lookup flow — the new system re-renders its own from structured data,
    // so those are intentionally skipped here to avoid pulling redundant data.
    const pageFileRefs = [];
    for (const d of docs) {
      for (const field of ["imageUrl", "logoUrl"]) {
        const storagePath = extractStoragePath(d[field], bucketName);
        if (!storagePath || seenFiles.has(storagePath)) continue;
        seenFiles.add(storagePath);
        pageFileRefs.push(storagePath);
      }
    }

    let pausedMidPage = false;
    await runWithConcurrency(pageFileRefs, FILE_CONCURRENCY, async (storagePath) => {
      if (isPaused()) {
        pausedMidPage = true;
        return;
      }
      const localPath = path.join(destination, "files", storagePath);
      const result = await downloadFileIfNeeded(bucket, storagePath, localPath);
      filesDone++;
      if (result.bytes) bytesDone += result.bytes;
      onProgress(chunk.id, { filesDone, bytesDone }, true);
    });
    if (pausedMidPage) throw new PauseSignal();

    cursor = snap.docs[snap.docs.length - 1].id;
    pagesDone++;
    docCount += docs.length;
    onProgress(chunk.id, { docCount, pagesDone, lastDocId: cursor, filesDone, bytesDone }, true);

    if (snap.docs.length < pageSize) break;
  }

  onProgress(chunk.id, { status: "done" }, false);
}

async function processOldCertificatesMeta(chunk, ctx) {
  const { db, destination, onProgress, isPaused, state } = ctx;
  const dataDir = path.join(destination, "data", "old-certificates-meta");
  fs.mkdirSync(dataDir, { recursive: true });

  const cs = state.chunks[chunk.id];
  const pageSize = 2000;
  let cursor = cs.lastDocId;
  let pagesDone = cs.pagesDone || 0;
  let docCount = cs.docCount || 0;

  while (true) {
    if (isPaused()) throw new PauseSignal();

    const snap = await paginateCollection(db, "OLD_CERTIFICATES", pageSize, cursor);
    if (snap.empty) break;

    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const pageFile = path.join(dataDir, `page-${String(pagesDone).padStart(5, "0")}.json`);
    fs.writeFileSync(pageFile, JSON.stringify(docs, null, 2));

    cursor = snap.docs[snap.docs.length - 1].id;
    pagesDone++;
    docCount += docs.length;
    onProgress(chunk.id, { docCount, pagesDone, lastDocId: cursor }, true);

    if (snap.docs.length < pageSize) break;
  }

  onProgress(chunk.id, { status: "done" }, false);
}

// Compares Certified Diamonds doc IDs against OLD_CERTIFICATES doc IDs.
// Firestore doc IDs match 1:1 between the two collections for every certificate
// generated through the normal digital workflow (both are written with the same
// dataId in a single batch). Any OLD_CERTIFICATES doc whose ID has no matching
// Certified Diamonds doc was added through the separate addOldCertificate
// manual-upload endpoint — a genuine pre-digital scan with no structured data
// behind it. Those are the only oldCertificate/ images actually needed.
async function processLegacyOnlyImages(chunk, ctx) {
  const { bucket, destination, onProgress, isPaused } = ctx;

  // Some external drives (exFAT/FAT32) cause macOS to write hidden AppleDouble
  // sidecar files (e.g. "._page-0000.json") alongside every real file. These
  // are binary, not JSON, so they must be filtered out before parsing.
  const isPageFile = (f) => f.endsWith(".json") && !f.startsWith("._");

  const cdDir = path.join(destination, "data", "certified-diamonds");
  const cdIds = new Set();
  if (fs.existsSync(cdDir)) {
    for (const f of fs.readdirSync(cdDir).filter(isPageFile)) {
      const docs = JSON.parse(fs.readFileSync(path.join(cdDir, f), "utf8"));
      docs.forEach((d) => cdIds.add(d.id));
    }
  }

  const ocDir = path.join(destination, "data", "old-certificates-meta");
  const legacyOnly = [];
  if (fs.existsSync(ocDir)) {
    for (const f of fs.readdirSync(ocDir).filter(isPageFile)) {
      const docs = JSON.parse(fs.readFileSync(path.join(ocDir, f), "utf8"));
      for (const d of docs) {
        if (!cdIds.has(d.id)) legacyOnly.push(d);
      }
    }
  }

  fs.mkdirSync(path.join(destination, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(destination, "data", "legacy-only-certificates.json"),
    JSON.stringify(legacyOnly, null, 2)
  );
  onProgress(chunk.id, { docCount: legacyOnly.length, fileCount: legacyOnly.length });

  const bucketName = bucket.name;
  // imageUrl is the front scan; logoUrl on these particular (legacy-only)
  // records is actually the *back*-of-certificate scan, not a real logo —
  // both are genuine source images with no structured backing, so both need
  // pulling down.
  const refs = [];
  for (const d of legacyOnly) {
    if (d.imageUrl) refs.push(d.imageUrl);
    if (d.logoUrl) refs.push(d.logoUrl);
  }
  const seen = new Set();
  let filesDone = 0;
  let bytesDone = 0;
  let pausedMidRun = false;
  await runWithConcurrency(refs, FILE_CONCURRENCY, async (url) => {
    if (isPaused()) {
      pausedMidRun = true;
      return;
    }
    const storagePath = extractStoragePath(url, bucketName);
    if (storagePath && !seen.has(storagePath)) {
      seen.add(storagePath);
      const localPath = path.join(destination, "files", storagePath);
      const result = await downloadFileIfNeeded(bucket, storagePath, localPath);
      if (result.bytes) bytesDone += result.bytes;
    }
    filesDone++;
    onProgress(chunk.id, { filesDone, bytesDone }, true);
  });
  if (pausedMidRun) throw new PauseSignal();

  onProgress(chunk.id, { status: "done" }, false);
}

// brandLogoUrl is a genuinely distinct file from imageUrl/logoUrl (confirmed:
// 11,128 of 63,424 docs have one, never equal to that doc's logoUrl) that the
// original certified-diamonds pass didn't fetch — it only pulled imageUrl/
// logoUrl. This chunk fills that gap without re-touching already-downloaded
// pages.
async function processBrandLogos(chunk, ctx) {
  const { bucket, destination, onProgress, isPaused } = ctx;

  const cdDir = path.join(destination, "data", "certified-diamonds");
  const isPageFile = (f) => f.endsWith(".json") && !f.startsWith("._");
  const refs = [];
  if (fs.existsSync(cdDir)) {
    for (const f of fs.readdirSync(cdDir).filter(isPageFile)) {
      const docs = JSON.parse(fs.readFileSync(path.join(cdDir, f), "utf8"));
      for (const d of docs) {
        if (d.brandLogoUrl) refs.push(d.brandLogoUrl);
      }
    }
  }

  const bucketName = bucket.name;
  const seen = new Set();
  let filesDone = 0;
  let bytesDone = 0;
  let pausedMidRun = false;
  await runWithConcurrency(refs, FILE_CONCURRENCY, async (url) => {
    if (isPaused()) {
      pausedMidRun = true;
      return;
    }
    const storagePath = extractStoragePath(url, bucketName);
    if (storagePath && !seen.has(storagePath)) {
      seen.add(storagePath);
      const localPath = path.join(destination, "files", storagePath);
      const result = await downloadFileIfNeeded(bucket, storagePath, localPath);
      if (result.bytes) bytesDone += result.bytes;
    }
    filesDone++;
    onProgress(chunk.id, { docCount: filesDone, fileCount: refs.length, filesDone, bytesDone }, true);
  });
  if (pausedMidRun) throw new PauseSignal();

  onProgress(chunk.id, { status: "done" }, false);
}

function allCertifiedDiamondsChunksDone(chunks, state) {
  return chunks
    .filter((c) => c.type === "certified-diamonds")
    .every((c) => state.chunks[c.id].status === "done");
}

function dependenciesMet(chunk, chunks, state) {
  if (!chunk.dependsOn) return true;
  return chunk.dependsOn.every((dep) =>
    dep === "__all_certified_diamonds__"
      ? allCertifiedDiamondsChunksDone(chunks, state)
      : state.chunks[dep] && state.chunks[dep].status === "done"
  );
}

async function processChunk(chunk, ctx) {
  switch (chunk.type) {
    case "certified-diamonds":
      return processCertifiedDiamondsChunk(chunk, ctx);
    case "old-certificates-meta":
      return processOldCertificatesMeta(chunk, ctx);
    case "legacy-only-images":
      return processLegacyOnlyImages(chunk, ctx);
    case "brand-logos":
      return processBrandLogos(chunk, ctx);
    default:
      throw new Error(`Unknown chunk type: ${chunk.type}`);
  }
}

module.exports = {
  PauseSignal,
  processChunk,
  dependenciesMet,
  extractStoragePath,
  downloadFileIfNeeded,
  runWithConcurrency,
};
