const fs = require("fs");
const path = require("path");

// Unlike the Extract chunk plan (static, built from a date range), the Load
// plan depends on what Transform actually produced, so it's read from disk
// each time rather than computed from config.
function buildLoadChunkPlan(destination) {
  const chunks = [{ id: "clients", type: "clients", label: "Clients (deduped from customer names)" }];

  const dir = path.join(destination, "data", "transformed");
  if (fs.existsSync(dir)) {
    const months = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("certifications__") && f.endsWith(".json"))
      .map((f) => f.slice("certifications__".length, -".json".length))
      .sort();
    for (const mk of months) {
      chunks.push({
        id: `certs-${mk}`,
        type: "certifications",
        label: `Certifications — ${mk}`,
        month: mk,
        dependsOn: ["clients"],
      });
    }
  }

  return chunks;
}

module.exports = { buildLoadChunkPlan };
