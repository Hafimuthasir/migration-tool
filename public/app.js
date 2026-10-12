function fmtBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function fmtTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString();
}

function fmtEta(seconds, allDone) {
  if (allDone) return "done";
  if (seconds == null) return "estimating…";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m}m` : `${h}h ${m}m`;
}

// ─────────────────────────────── Tabs ───────────────────────────────

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  };
});

// ────────────────────────────── Extract ──────────────────────────────

function renderExtract({ chunks, state, speedBytesPerSec, etaSeconds }) {
  document.getElementById("extractPausedBadge").hidden = !state.paused;

  let totalDone = 0;
  let totalCount = chunks.length;
  let totalBytes = 0;
  let totalDocs = 0;

  const rows = chunks
    .map((chunk) => {
      const cs = state.chunks[chunk.id] || {};
      if (cs.status === "done") totalDone++;
      totalBytes += cs.bytesDone || 0;
      totalDocs += cs.docCount || 0;

      const retryBtn =
        cs.status === "failed"
          ? `<button class="btn small" onclick="retryExtractChunk('${chunk.id}')">Retry</button>`
          : "";

      return `
        <tr>
          <td>${chunk.label}</td>
          <td class="status-${cs.status}">${cs.status}${cs.error ? ` — ${cs.error}` : ""}</td>
          <td>${cs.docCount || 0}</td>
          <td>${cs.filesDone || 0}${cs.fileCount ? ` / ${cs.fileCount}` : ""}</td>
          <td>${fmtBytes(cs.bytesDone)}</td>
          <td>${fmtTime(cs.updatedAt)}</td>
          <td>${retryBtn}</td>
        </tr>
      `;
    })
    .join("");

  document.getElementById("extractBody").innerHTML = rows;
  document.getElementById("extractSummary").innerHTML = `
    <div><strong>${totalDone}</strong> / ${totalCount} chunks done</div>
    <div><strong>${totalDocs}</strong> documents pulled</div>
    <div><strong>${fmtBytes(totalBytes)}</strong> downloaded so far</div>
    <div><strong>${fmtBytes(speedBytesPerSec || 0)}/s</strong> current speed</div>
    <div><strong>${fmtEta(etaSeconds, totalDone === totalCount)}</strong> estimated remaining</div>
  `;
}

window.retryExtractChunk = (id) => post(`/api/chunks/${id}/retry`);

document.getElementById("extractStartAll").onclick = () => post("/api/start-all");
document.getElementById("extractPause").onclick = () => post("/api/pause");
document.getElementById("extractResume").onclick = () => post("/api/resume");

// ───────────────────────────── Transform ─────────────────────────────

function renderTransform(transform) {
  document.getElementById("transformRunningBadge").hidden = !transform.running;
  document.getElementById("transformRun").disabled = transform.running;

  const errorBox = document.getElementById("transformError");
  errorBox.hidden = !transform.error;
  errorBox.textContent = transform.error || "";

  const report = transform.report;
  const summary = document.getElementById("transformSummary");
  const typesTable = document.getElementById("transformTypesTable");
  const unmappedSection = document.getElementById("transformUnmapped");

  if (!report) {
    summary.innerHTML = `<div>No transform run yet.</div>`;
    typesTable.hidden = true;
    unmappedSection.hidden = true;
    return;
  }

  summary.innerHTML = `
    <div><strong>${report.totalMapped}</strong> certificates mapped</div>
    <div><strong>${report.totalClients}</strong> clients (deduped)</div>
    <div><strong>${report.totalLegacyOnly}</strong> legacy-only scans</div>
    <div><strong>${report.months.length}</strong> month chunks staged</div>
    <div><strong class="${report.unmappedCount ? "status-failed" : "status-done"}">${report.unmappedCount}</strong> unmapped</div>
    <div>generated ${fmtTime(report.generatedAt)}</div>
  `;

  typesTable.hidden = false;
  document.getElementById("transformTypesBody").innerHTML = Object.entries(report.typeCounts)
    .map(([type, count]) => `<tr><td>${type}</td><td>${count}</td></tr>`)
    .join("");

  if (report.unmappedCount) {
    unmappedSection.hidden = false;
    document.getElementById("transformUnmappedBody").innerHTML = report.unmapped
      .map((u) => `<tr><td>${u.certificateNo || u.id}</td><td>${u.type}</td></tr>`)
      .join("");
  } else {
    unmappedSection.hidden = true;
  }
}

document.getElementById("transformRun").onclick = () => post("/api/transform/run");

// ──────────────────────────────  Load  ───────────────────────────────

function renderLoad({ chunks, state, speedBytesPerSec }) {
  document.getElementById("loadPausedBadge").hidden = !state.paused;

  let totalDone = 0;
  let totalCount = chunks.length;
  let totalBytes = 0;
  let totalDocs = 0;

  const rows = chunks
    .map((chunk) => {
      const cs = state.chunks[chunk.id] || {};
      if (cs.status === "done") totalDone++;
      totalBytes += cs.bytesDone || 0;
      totalDocs += cs.docCount || 0;

      const retryBtn =
        cs.status === "failed"
          ? `<button class="btn small" onclick="retryLoadChunk('${chunk.id}')">Retry</button>`
          : "";
      const skippedNote = cs.skipped ? ` (${cs.skipped} already loaded)` : "";

      return `
        <tr>
          <td>${chunk.label}</td>
          <td class="status-${cs.status}">${cs.status}${cs.error ? ` — ${cs.error}` : ""}</td>
          <td>${cs.docCount || 0}${cs.fileCount ? ` / ${cs.fileCount}` : ""}${skippedNote}</td>
          <td>${cs.filesDone || 0}</td>
          <td>${fmtBytes(cs.bytesDone)}</td>
          <td>${fmtTime(cs.updatedAt)}</td>
          <td>${retryBtn}</td>
        </tr>
      `;
    })
    .join("");

  document.getElementById("loadBody").innerHTML = rows;
  document.getElementById("loadSummary").innerHTML = `
    <div><strong>${totalDone}</strong> / ${totalCount} chunks done</div>
    <div><strong>${totalDocs}</strong> documents loaded</div>
    <div><strong>${fmtBytes(totalBytes)}</strong> uploaded so far</div>
    <div><strong>${fmtBytes(speedBytesPerSec || 0)}/s</strong> current speed</div>
  `;
}

window.retryLoadChunk = (id) => post(`/api/load/chunks/${id}/retry`);

document.getElementById("loadStartAll").onclick = () => post("/api/load/start-all");
document.getElementById("loadPause").onclick = () => post("/api/load/pause");
document.getElementById("loadResume").onclick = () => post("/api/load/resume");

// ──────────────────────────────  Wiring  ──────────────────────────────

async function post(url) {
  await fetch(url, { method: "POST" });
}

function render(payload) {
  renderExtract(payload.extract);
  renderTransform(payload.transform);
  renderLoad(payload.load);
}

const source = new EventSource("/api/events");
source.onmessage = (e) => render(JSON.parse(e.data));
