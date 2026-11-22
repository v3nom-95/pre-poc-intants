// Post-build step for the static export.
//
// Next.js 16 writes per-segment RSC payloads as nested folders, for example
// out/plan/__next.plan/__PAGE__.txt, but the client router prefetches the
// flattened name out/plan/__next.plan.__PAGE__.txt. A plain static server then
// answers 404 and the browser logs console errors on every page. This script
// writes a flattened copy next to each nested payload so both names resolve.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "out");

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith(".txt")) files.push(full);
  }
  return files;
}

let written = 0;
for (const file of walk(OUT)) {
  const parts = path.relative(OUT, file).split(path.sep);
  const idx = parts.findIndex((p, i) => i < parts.length - 1 && p.startsWith("__next."));
  if (idx === -1) continue;
  const flatName = parts.slice(idx).join(".");
  const target = path.join(OUT, ...parts.slice(0, idx), flatName);
  if (!fs.existsSync(target)) {
    fs.copyFileSync(file, target);
    written += 1;
  }
}
console.log(`flatten-rsc: wrote ${written} flattened RSC payload files`);
