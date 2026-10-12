const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

class PauseSignal extends Error {}

function loadProdConfig() {
  const p = path.join(__dirname, "..", "prod.config.json");
  if (!fs.existsSync(p)) {
    throw new Error("prod.config.json is missing — copy the template and fill in real production credentials.");
  }
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!cfg.mongodbUrl || cfg.mongodbUrl.startsWith("REPLACE_ME")) {
    throw new Error("prod.config.json is still a template — fill in the real production MongoDB/R2 credentials before loading.");
  }
  return cfg;
}

let _mongoClient = null;
let _db = null;
async function getDb() {
  if (_db) return _db;
  const cfg = loadProdConfig();
  _mongoClient = new MongoClient(cfg.mongodbUrl);
  await _mongoClient.connect();
  _db = _mongoClient.db(cfg.databaseName);
  return _db;
}

let _s3 = null;
function getS3() {
  if (_s3) return _s3;
  const cfg = loadProdConfig();
  _s3 = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: cfg.r2.accessKeyId,
      secretAccessKey: cfg.r2.secretAccessKey,
    },
  });
  return _s3;
}

function certificatesBucket() {
  return loadProdConfig().r2.certificatesBucket || "certificates";
}

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
function contentTypeFor(filename) {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Uploads a { localPath, originalName } file ref (as produced by transform.js)
// into the given bucket under a fresh key, matching the naming convention
// promote_file_from_temp() already uses in the backend (uuid_originalname).
// Returns the "bucket/key" string the backend stores in *_url fields, or null
// if there was no file to upload.
async function uploadFileRef(ref, bucket) {
  if (!ref) return null;
  const s3 = getS3();
  const key = `${crypto.randomUUID()}_${ref.originalName}`;
  const body = fs.readFileSync(ref.localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentTypeFor(ref.originalName),
    })
  );
  return { url: `${bucket}/${key}`, bytes: body.length };
}

let _categorySchemaCache = null;
async function categoryIdForGroup(db, group) {
  if (!group) return null;
  if (!_categorySchemaCache) {
    const docs = await db.collection("category_schemas").find({}).toArray();
    _categorySchemaCache = new Map(docs.map((d) => [d.group, d.uuid]));
  }
  return _categorySchemaCache.get(group) || null;
}

async function processClientsChunk(chunk, ctx) {
  const { destination, onProgress, isPaused } = ctx;
  const db = await getDb();

  const clientsPath = path.join(destination, "data", "transformed", "clients.json");
  const roster = JSON.parse(fs.readFileSync(clientsPath, "utf8"));

  const idMap = {};
  let done = 0;
  let created = 0;
  let matched = 0;

  for (const c of roster) {
    if (isPaused()) throw new PauseSignal();

    const existing = await db.collection("clients").findOne({
      name: { $regex: `^${escapeRegex(c.name)}$`, $options: "i" },
      is_deleted: false,
    });

    if (existing) {
      idMap[c.key] = existing.uuid;
      matched++;
    } else {
      const uuid = crypto.randomUUID();
      const brandLogo = await uploadFileRef(c.brand_logo, "client-logos");
      const rearLogo = await uploadFileRef(c.rear_logo, "client-logos");
      const now = new Date();
      await db.collection("clients").insertOne({
        uuid,
        name: c.name,
        contact_person: null,
        email: null,
        phone: null,
        address: null,
        gst_number: null,
        notes: "Migrated from legacy GAC system",
        brand_logo_url: brandLogo ? brandLogo.url : null,
        rear_logo_url: rearLogo ? rearLogo.url : null,
        // See the same field on certifications below.
        logo_fields_swapped: true,
        is_deleted: false,
        created_by: { user_id: "migration", name: "Migration Tool", email: "migration@local" },
        created_at: now,
        updated_at: now,
      });
      idMap[c.key] = uuid;
      created++;
    }

    done++;
    onProgress(chunk.id, { docCount: done, fileCount: roster.length, created, matched }, true);
  }

  fs.writeFileSync(
    path.join(destination, "data", "transformed", "client-id-map.json"),
    JSON.stringify(idMap, null, 2)
  );

  onProgress(chunk.id, { status: "done", docCount: done }, false);
}

async function processCertificationsChunk(chunk, ctx) {
  const { destination, onProgress, isPaused } = ctx;
  const db = await getDb();
  const bucket = certificatesBucket();

  const filePath = path.join(destination, "data", "transformed", `certifications__${chunk.month}.json`);
  const certs = JSON.parse(fs.readFileSync(filePath, "utf8"));

  const idMapPath = path.join(destination, "data", "transformed", "client-id-map.json");
  const idMap = fs.existsSync(idMapPath) ? JSON.parse(fs.readFileSync(idMapPath, "utf8")) : {};

  let docCount = 0;
  let filesDone = 0;
  let bytesDone = 0;
  let skipped = 0;

  for (const c of certs) {
    if (isPaused()) throw new PauseSignal();

    // Pre-insert existence check on the DB's own unique index — makes
    // re-running a chunk (partial failure, or a deliberate small test run
    // re-clicked) safe: already-loaded certs are counted as skipped, not
    // re-inserted or errored.
    const already = await db.collection("certifications").findOne({ certificate_number: c.certificate_number });
    if (already) {
      skipped++;
      docCount++;
      onProgress(chunk.id, { docCount, fileCount: certs.length, skipped }, true);
      continue;
    }

    const category_id = await categoryIdForGroup(db, c.category_group);
    const client_id = idMap[c.client_key] || null;

    const photo = await uploadFileRef(c.photo, bucket);
    const brandLogo = await uploadFileRef(c.brand_logo, bucket);
    const rearLogo = await uploadFileRef(c.rear_brand_logo, bucket);
    for (const up of [photo, brandLogo, rearLogo]) {
      if (up) {
        filesDone++;
        bytesDone += up.bytes;
      }
    }

    const createdAt = new Date(c.created_at);
    await db.collection("certifications").insertOne({
      uuid: crypto.randomUUID(),
      certificate_number: c.certificate_number,
      type: c.type,
      client_id,
      job_id: "",
      category_id,
      fields: c.fields,
      photo_url: photo ? photo.url : null,
      brand_logo_url: brandLogo ? brandLogo.url : null,
      rear_brand_logo_url: rearLogo ? rearLogo.url : null,
      is_deleted: false,
      // transform.js always sets is_published:true for every migrated cert
      // (rejected or not — see its comment: rejection never un-publishes a
      // cert in this app's real model). Migrated certs are historical
      // records, not the app's "current live batch" — marking them
      // is_history up front keeps them out of the Published tab (which only
      // ever holds the most recent manually-published batch) so they don't
      // get mixed in with, then swept away by, the next real publish action
      // a staff member takes.
      is_published: c.is_published,
      is_history: true,
      published_at: createdAt,
      is_rejected: c.is_rejected,
      rejected_at: c.is_rejected ? createdAt : null,
      created_at: createdAt,
      updated_at: createdAt,
      migration_source_id: c.source_id,
      // Marks the logo pair as already in the app's orientation (front =
      // small badge, rear = full-bleed card art). The legacy source names
      // these the other way round, and transform.js used to carry that
      // inversion through; the 63,424 documents migrated before it was
      // fixed were repaired by a one-off swap that skips anything already
      // flagged. Stamping it here keeps records loaded from now on — which
      // are mapped correctly — out of that repair's reach.
      logo_fields_swapped: true,
    });

    docCount++;
    onProgress(chunk.id, { docCount, fileCount: certs.length, filesDone, bytesDone, skipped }, true);
  }

  onProgress(chunk.id, { status: "done", docCount }, false);
}

async function processLoadChunk(chunk, ctx) {
  switch (chunk.type) {
    case "clients":
      return processClientsChunk(chunk, ctx);
    case "certifications":
      return processCertificationsChunk(chunk, ctx);
    default:
      throw new Error(`Unknown load chunk type: ${chunk.type}`);
  }
}

module.exports = { PauseSignal, processLoadChunk, loadProdConfig };
