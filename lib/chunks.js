const config = require("../config.json");

// Certificate numbers look like G{YY}{MM}{DD}{serial}, e.g. G25121729424 = 17 Dec 2025.
// The YYMMDD block is always a fixed 6 digits right after the "G", regardless of
// serial length, so a prefix range query per year-month is a reliable partition key
// even though the serial itself doesn't zero-pad consistently.
//
// The start month is intentionally conservative (config.monthRangeStart, defaults to
// Jan 2020) rather than the ~Feb 2025 we observed in a small sample: querying a month
// with zero matching documents costs one cheap Firestore read and completes instantly,
// so over-including empty early months is harmless, while under-including a real month
// would silently lose certificates.

function buildChunkPlan() {
  const chunks = [];
  const { year: startYear, month: startMonth } = config.monthRangeStart;
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  let y = startYear;
  let m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const yy = String(y % 100).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    const id = `${y}-${mm}`;
    const prefix = `G${yy}${mm}`;
    chunks.push({
      id,
      type: "certified-diamonds",
      label: `Certified Diamonds — ${id}`,
      prefixStart: prefix,
      // '\uf8ff' is a Unicode Private Use Area code point that sorts after
      // virtually any real character, so "< prefix + '\uf8ff'" matches every
      // certificateNo that starts with this month's prefix. This used to be
      // just `prefix` itself (no +'\uf8ff'), making the upper bound equal to
      // the lower bound -- e.g. ">= G2610 AND < G2610" -- which excluded
      // every real certificate number longer than the bare 5-character
      // prefix (lexicographically "G2610" < "G26100245742", so the longer
      // real cert number never satisfied "< G2610"). Went unnoticed because
      // every chunk run so far happened to be the current month, with
      // nothing newer in Firestore to wrongly admit -- so the bugged "match
      // nothing" query and the correct "match this month" query produced
      // the same observed result by coincidence.
      prefixEnd: prefix + "",
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  chunks.push({
    id: "old-certificates-meta",
    type: "old-certificates-meta",
    label: "OLD_CERTIFICATES metadata (all documents, no images yet)",
  });

  chunks.push({
    id: "legacy-only-images",
    type: "legacy-only-images",
    label: "Legacy-only certificate scans (images for certs with no structured record)",
    dependsOn: ["__all_certified_diamonds__", "old-certificates-meta"],
  });

  chunks.push({
    id: "brand-logos",
    type: "brand-logos",
    label: "Brand logos (brandLogoUrl — distinct rear-logo files not covered by imageUrl/logoUrl)",
    dependsOn: ["__all_certified_diamonds__"],
  });

  return chunks;
}

module.exports = { buildChunkPlan };
