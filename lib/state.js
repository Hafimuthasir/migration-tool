const fs = require("fs");
const path = require("path");

function statePath(destination, fileName = "state.json") {
  return path.join(destination, fileName);
}

function defaultChunkState() {
  return {
    status: "pending", // pending | in_progress | done | failed
    docCount: 0,
    fileCount: 0,
    filesDone: 0,
    bytesDone: 0,
    pagesDone: 0,
    lastDocId: null,
    error: null,
    updatedAt: null,
  };
}

function loadState(destination, chunks, fileName = "state.json") {
  fs.mkdirSync(destination, { recursive: true });
  const p = statePath(destination, fileName);
  let state;
  if (fs.existsSync(p)) {
    state = JSON.parse(fs.readFileSync(p, "utf8"));
  } else {
    state = { paused: false, chunks: {} };
  }
  // merge in any chunk defs not already present (new months added over time)
  for (const c of chunks) {
    if (!state.chunks[c.id]) state.chunks[c.id] = defaultChunkState();
  }
  // Any chunk still marked in_progress belongs to a previous run that was
  // stopped (Ctrl+C, crash, etc.) mid-chunk — nothing is actively working on
  // it anymore, and the scheduler only ever reclaims "pending" chunks, so
  // left alone it would sit there forever, stuck, never resumed. Its saved
  // lastDocId/pagesDone/filesDone/bytesDone are still valid, so resetting to
  // pending lets it get picked back up and continue from exactly where it
  // left off rather than restarting from scratch.
  for (const cs of Object.values(state.chunks)) {
    if (cs.status === "in_progress") cs.status = "pending";
  }
  saveState(destination, state, fileName);
  return state;
}

function saveState(destination, state, fileName = "state.json") {
  // The external drive holding `destination` has intermittently dropped for
  // a moment mid-run (observed multiple times during the full load). A write
  // landing in that gap must not crash the whole server and lose in-memory
  // progress for every other chunk — log and let the next save (or a later
  // retry/resume) persist it instead.
  try {
    fs.writeFileSync(statePath(destination, fileName), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`saveState failed (will retry on next progress update): ${err.message}`);
  }
}

module.exports = { loadState, saveState, statePath, defaultChunkState };
