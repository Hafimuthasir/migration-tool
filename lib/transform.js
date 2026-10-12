const fs = require("fs");
const path = require("path");
const config = require("../config.json");
const { extractStoragePath } = require("./downloader");

const isPageFile = (f) => f.endsWith(".json") && !f.startsWith("._");

function loadPages(dir) {
  const docs = [];
  if (!fs.existsSync(dir)) return docs;
  for (const f of fs.readdirSync(dir).filter(isPageFile)) {
    docs.push(...JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  }
  return docs;
}

// Old `type` free-text values -> new certificate_types.slug == category_schemas.group
// (seed_schemas.py uses the same string for both). "excel" batch-imported records
// carry the same flat field shape as "single diamond", just tagged differently
// because they came through a separate bulk-upload path.
const TYPE_MAP = {
  "single diamond": "single_diamond",
  excel: "single_diamond",
  "single mound": "single_mounted",
  "loose stone": "loose_stone",
  "loose diamond": "loose_diamond",
  "double mound": "double_mounded",
  navaratna: "navaratna",
};

// "8.80 x 7.00 x 3.70 mm" -> {length, width, height}, matching how the new
// frontend stores/reads composite fields (CertificateCard.jsx formatFieldValue).
function parseDimension(str) {
  if (!str || typeof str !== "string") return undefined;
  const cleaned = str.replace(/mm/gi, "").trim();
  const parts = cleaned
    .split(/x/i)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  const out = {};
  if (parts[0]) out.length = parts[0];
  if (parts[1]) out.width = parts[1];
  if (parts[2]) out.height = parts[2];
  return out;
}

function sgRiHardness(d) {
  const out = {};
  if (d.sg != null && d.sg !== "") out.sg = d.sg;
  if (d.ri != null && d.ri !== "") out.ri = d.ri;
  if (d.hardness != null && d.hardness !== "") out.hardness = d.hardness;
  return Object.keys(out).length ? out : undefined;
}

function set(fields, key, value) {
  if (value != null && value !== "") fields[key] = value;
}

// One mapper per new group, matching field_name keys exactly as seeded in
// app/utils/seed_schemas.py.
const FIELD_MAPPERS = {
  single_diamond(d) {
    const fields = {};
    set(fields, "category", d.category);
    set(fields, "metal", d.metal);
    set(fields, "cut", d.cut);
    set(fields, "clarity", d.clarity);
    set(fields, "color", d.color);
    set(fields, "conclusion", d.conclusion);
    set(fields, "gross_weight", d.grossWeight);
    set(fields, "diamond_weight", d.diamondWeight);
    set(fields, "diamond_piece", d.diamondPiece);
    set(fields, "comment", d.comment);
    return fields;
  },
  loose_diamond(d) {
    const fields = {};
    const dim = parseDimension(d.dimension);
    if (dim) fields.dimension = dim;
    set(fields, "shape", d.shape);
    const srh = sgRiHardness(d);
    if (srh) fields.sg_ri_hardness = srh;
    set(fields, "clarity", d.clarity);
    set(fields, "color", d.color);
    set(fields, "weight", d.weight);
    set(fields, "microscopic_obs", d.microscopicobs);
    set(fields, "conclusion", d.conclusion);
    set(fields, "comment", d.comment);
    return fields;
  },
  loose_stone(d) {
    const fields = {};
    set(fields, "gemstone", d.gemstone);
    const dim = parseDimension(d.dimension);
    if (dim) fields.dimension = dim;
    set(fields, "shape", d.shape);
    set(fields, "weight", d.weight);
    set(fields, "color", d.color);
    const srh = sgRiHardness(d);
    if (srh) fields.sg_ri_hardness = srh;
    set(fields, "microscopic_obs", d.microscopicobs);
    set(fields, "conclusion", d.conclusion);
    set(fields, "comment", d.comment);
    return fields;
  },
  single_mounted(d) {
    const fields = {};
    set(fields, "gemstone", d.gemstone);
    set(fields, "category", d.category);
    set(fields, "metal", d.metal);
    set(fields, "gemstone_piece", d.gemstonePiece);
    set(fields, "shape", d.shape);
    set(fields, "hardness", d.hardness);
    set(fields, "sg", d.sg);
    set(fields, "ri", d.ri);
    set(fields, "stone_weight", d.stoneWeight);
    set(fields, "gross_weight", d.grossWeight);
    set(fields, "microscopic_obs", d.microscopicobs);
    set(fields, "conclusion", d.conclusion);
    set(fields, "comment", d.comment);
    return fields;
  },
  double_mounded(d) {
    const fields = {};
    set(fields, "primary_gemstone", d.primaryGemstone);
    set(fields, "secondary_gemstone", d.secondaryGemstone);
    set(fields, "category", d.category);
    set(fields, "metal", d.metal);
    set(fields, "primary_gemstone_piece", d.primaryGemstonePiece);
    set(fields, "secondary_gemstone_piece", d.secondaryGemstonePiece);
    set(fields, "shape", d.shape);
    set(fields, "cut", d.cut);
    set(fields, "clarity", d.clarity);
    set(fields, "colour", d.color); // renamed for this group only
    set(fields, "hardness", d.hardness);
    set(fields, "sg", d.sg);
    set(fields, "ri", d.ri);
    set(fields, "primary_stone_weight", d.primaryStoneWeight);
    set(fields, "secondary_stone_weight", d.secondaryStoneWeight);
    set(fields, "gross_weight", d.grossWeight);
    set(fields, "microscopic_obs", d.microscopicobs);
    set(fields, "conclusion", d.conclusion);
    return fields;
  },
  navaratna(d) {
    const fields = {};
    set(fields, "category", d.category);
    set(fields, "metal", d.metal);
    set(fields, "cut", d.cut);
    set(fields, "clarity", d.clarity);
    set(fields, "color", d.color);
    set(fields, "conclusion", d.conclusion);
    set(fields, "gross_weight", d.grossWeight);
    set(fields, "diamond_weight", d.diamondWeight);
    set(fields, "diamond_piece", d.diamondPiece);
    set(fields, "comment", d.comment);
    return fields;
  },
};

function parseCertificationDate(d) {
  if (d.certificationDate) {
    const dt = new Date(d.certificationDate);
    if (!isNaN(dt.getTime())) return dt.toISOString();
  }
  // Fallback: old "date" field is DD/MM/YYYY.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d.date || "");
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).toISOString();
  return new Date().toISOString();
}

function parseUploadedAt(str) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str || "");
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])).toISOString();
  return new Date().toISOString();
}

// One up-front recursive walk + Set membership check, instead of an
// fs.existsSync() syscall per image reference (up to ~190k of them across
// the full dataset) — on a slow/just-woken external drive those individual
// stats each cost several ms, turning the transform into a multi-hour run.
// A directory walk is comparatively sequential I/O and finishes in seconds.
function indexExistingFiles(destination) {
  const filesDir = path.join(destination, "files");
  const existing = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith("._")) continue; // AppleDouble sidecar files
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        existing.add(path.relative(filesDir, full));
      }
    }
  }
  if (fs.existsSync(filesDir)) walk(filesDir);
  return existing;
}

function fileRef(url, bucketName, destination, existingFiles) {
  const storagePath = extractStoragePath(url, bucketName);
  if (!storagePath) return null;
  if (!existingFiles.has(storagePath)) return null;
  const localPath = path.join(destination, "files", storagePath);
  return { localPath, originalName: path.basename(decodeURIComponent(storagePath)) };
}

const LEGACY_CLIENT_KEY = "__legacy__";

function transform() {
  const { destination } = config;
  // Same bucket-name convention firebase.js uses: no live Firebase connection
  // needed here, this step only touches already-downloaded local files.
  const serviceAccount = require(config.serviceAccountKeyPath);
  const bucketName = `${serviceAccount.project_id}.appspot.com`;

  const cdDir = path.join(destination, "data", "certified-diamonds");
  const cdDocs = loadPages(cdDir);
  const legacyPath = path.join(destination, "data", "legacy-only-certificates.json");
  const legacyDocs = fs.existsSync(legacyPath)
    ? JSON.parse(fs.readFileSync(legacyPath, "utf8"))
    : [];

  const existingFiles = indexExistingFiles(destination);

  const clients = new Map(); // key -> { key, name, images: { brand_logo, rear_logo } }
  const byMonth = new Map(); // "YYYY-MM" -> [] certs
  const unmapped = [];
  const typeCounts = {};

  function monthKeyFor(isoDate) {
    return isoDate.slice(0, 7);
  }

  function ensureClient(rawName, certDoc) {
    const name = (rawName || "").trim();
    const key = name.toLowerCase() || LEGACY_CLIENT_KEY;
    if (!clients.has(key)) {
      clients.set(key, {
        key,
        name: name || "Unattributed",
        brand_logo: null,
        rear_logo: null,
      });
    }
    const client = clients.get(key);
    // First-seen wins — good enough for a stub; staff can correct in the UI later.
    if (!client.brand_logo && certDoc.brand_logo) client.brand_logo = certDoc.brand_logo;
    if (!client.rear_logo && certDoc.rear_brand_logo) client.rear_logo = certDoc.rear_brand_logo;
    return key;
  }

  for (const d of cdDocs) {
    const group = TYPE_MAP[d.type];
    if (!group) {
      unmapped.push({ id: d.id, certificateNo: d.certificateNo, type: d.type });
      continue;
    }
    typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;

    const photo = fileRef(d.imageUrl, bucketName, destination, existingFiles);
    // The legacy field names invert the app's: `logoUrl` holds the
    // full-bleed card-BACK artwork and `brandLogoUrl` holds the client's
    // small front badge. Mapping them across by name put back artwork in
    // brand_logo_url (rendered as the 65x43 header badge) and the badge in
    // rear_brand_logo_url (rendered full-bleed) — confirmed on real data by
    // a file named "hamara front logo.jpg" sitting in the rear slot, by the
    // sizes (backs 1028x650/1200x723, badges 250x125), and by 82% of certs
    // ending up front-only with none back-only, which is backwards.
    const brand_logo = fileRef(d.brandLogoUrl, bucketName, destination, existingFiles);
    const rear_brand_logo = fileRef(d.logoUrl, bucketName, destination, existingFiles);

    const created_at = parseCertificationDate(d);
    const isRejected = d.status === "rejected";

    const certDoc = {
      source_id: d.id,
      certificate_number: d.certificateNo,
      type: group,
      category_group: group,
      fields: FIELD_MAPPERS[group](d),
      created_at,
      // The app's real semantics: rejection is an action taken on an
      // already-published cert (see the /reject endpoint's own
      // precondition) — is_published never flips to false for a rejected
      // cert, only is_rejected does. Every migrated doc here came from the
      // old system's "Certified Diamonds" collection, i.e. was certified/
      // published there too, rejected or not.
      is_published: true,
      is_rejected: isRejected,
      photo,
      brand_logo,
      rear_brand_logo,
    };

    certDoc.client_key = ensureClient(d.customername, certDoc);

    const mk = monthKeyFor(created_at);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(certDoc);
  }

  // 226 true legacy scans: no customer, no graded fields — a shared stub
  // client, minimal cert doc. `imageUrl` is the front scan; `logoUrl` on
  // these particular records is actually a *back*-of-certificate scan (no
  // dedicated schema slot exists for it, so it's noted in `fields` instead
  // of silently dropped).
  if (legacyDocs.length && !clients.has(LEGACY_CLIENT_KEY)) {
    clients.set(LEGACY_CLIENT_KEY, {
      key: LEGACY_CLIENT_KEY,
      name: "Legacy / Unattributed",
      brand_logo: null,
      rear_logo: null,
    });
  }
  for (const d of legacyDocs) {
    const photo = fileRef(d.imageUrl, bucketName, destination, existingFiles);
    const backScan = fileRef(d.logoUrl, bucketName, destination, existingFiles);
    const fields = {};
    if (backScan) {
      fields.legacy_back_scan_note = `Back-of-certificate scan on file (no dedicated field): ${backScan.originalName}`;
    }
    const isRejected = d.status === "rejected";
    const created_at = parseUploadedAt(d.uploadedAt);

    const certDoc = {
      source_id: d.id,
      certificate_number: d.certificateNumber,
      type: "legacy_scan",
      category_group: null,
      fields,
      created_at,
      // The app's real semantics: rejection is an action taken on an
      // already-published cert (see the /reject endpoint's own
      // precondition) — is_published never flips to false for a rejected
      // cert, only is_rejected does. Every migrated doc here came from the
      // old system's "Certified Diamonds" collection, i.e. was certified/
      // published there too, rejected or not.
      is_published: true,
      is_rejected: isRejected,
      photo,
      brand_logo: null,
      rear_brand_logo: null,
      back_scan: backScan,
      client_key: LEGACY_CLIENT_KEY,
    };

    const mk = monthKeyFor(created_at);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk).push(certDoc);
  }

  const outDir = path.join(destination, "data", "transformed");
  fs.mkdirSync(outDir, { recursive: true });

  // Clear any previous run's per-month files so a removed/renamed month
  // doesn't leave a stale file behind.
  for (const f of fs.readdirSync(outDir)) {
    if (f.startsWith("certifications__") && f.endsWith(".json")) {
      fs.unlinkSync(path.join(outDir, f));
    }
  }

  const months = [...byMonth.keys()].sort();
  for (const mk of months) {
    fs.writeFileSync(
      path.join(outDir, `certifications__${mk}.json`),
      JSON.stringify(byMonth.get(mk), null, 2)
    );
  }

  fs.writeFileSync(
    path.join(outDir, "clients.json"),
    JSON.stringify([...clients.values()], null, 2)
  );

  const totalCerts = cdDocs.length + legacyDocs.length - unmapped.length;
  const report = {
    generatedAt: new Date().toISOString(),
    totalOldCertifiedDiamonds: cdDocs.length,
    totalLegacyOnly: legacyDocs.length,
    totalMapped: totalCerts,
    totalClients: clients.size,
    months,
    typeCounts,
    unmappedCount: unmapped.length,
    unmapped: unmapped.slice(0, 50),
  };
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

  return report;
}

module.exports = { transform, TYPE_MAP, FIELD_MAPPERS, parseDimension };
