const fs = require("fs");
const { bucket } = require("/Users/Shared/underground/erp2/migration-tool/lib/firebase");

function toPath(u) {
  if (!u || typeof u !== "string") return null;
  let m = u.match(/storage\.googleapis\.com\/[^/]+\/(.+?)(\?|$)/);
  if (m) return decodeURIComponent(m[1]);
  m = u.match(/\/v0\/b\/[^/]+\/o\/(.+?)(\?|$)/);
  if (m) return decodeURIComponent(m[1]);
  return u.startsWith("http") ? null : u;
}

const arr = JSON.parse(fs.readFileSync("/Volumes/Untitled/gac-data/data/certified-diamonds/2026-08__page-0002.json","utf8"));
const paths = [];
for (const d of arr) {
  for (const k of ["imageUrl","logoUrl","brandLogoUrl"]) {
    const p = toPath(d[k]);
    if (p && !paths.includes(p)) paths.push(p);
    if (paths.length >= 12) break;
  }
  if (paths.length >= 12) break;
}
console.log("test paths:", paths.length);

(async () => {
  let bytes=0; const t0=Date.now();
  for (const p of paths.slice(0,4)) {
    const s=Date.now();
    try { const [b]=await bucket.file(p).download(); bytes+=b.length;
      console.log(`  seq ${((Date.now()-s)/1000).toFixed(2)}s ${(b.length/1024).toFixed(0)}KB`);
    } catch(e){ console.log("  seq ERR", e.code||e.message); }
  }
  const st=(Date.now()-t0)/1000;
  console.log(`SEQUENTIAL: ${(bytes/1024).toFixed(0)}KB in ${st.toFixed(1)}s = ${(bytes/1024/st).toFixed(0)} KB/s`);

  const par=paths.slice(0,12); let pb=0; const t1=Date.now();
  await Promise.all(par.map(async p => { try { const [b]=await bucket.file(p).download(); pb+=b.length; } catch(e){} }));
  const pt=(Date.now()-t1)/1000;
  console.log(`PARALLEL(${par.length}): ${(pb/1024).toFixed(0)}KB in ${pt.toFixed(1)}s = ${(pb/1024/pt).toFixed(0)} KB/s`);
  process.exit(0);
})();
