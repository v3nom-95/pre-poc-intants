// Serialises `npm run build` (and an optional follow-up command, for example a
// screenshot script) between several local workers sharing this web folder.
// Usage: node scripts/locked-build.cjs [-- <command to run after the build>]
// The lock is a directory (mkdir is atomic). A lock older than 20 minutes is
// treated as stale and removed.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCK = path.join(__dirname, "..", ".buildlock");
const STALE_MS = 20 * 60 * 1000;
const WAIT_MS = 15 * 1000;
const MAX_WAIT_MS = 40 * 60 * 1000;

function tryLock() {
  try {
    fs.mkdirSync(LOCK);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const age = Date.now() - fs.statSync(LOCK).mtimeMs;
    if (age > STALE_MS) {
      fs.rmSync(LOCK, { recursive: true, force: true });
      return tryLock();
    }
    return false;
  }
}

function run(cmd) {
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: path.join(__dirname, "..") });
  return r.status ?? 1;
}

(async () => {
  const start = Date.now();
  while (!tryLock()) {
    if (Date.now() - start > MAX_WAIT_MS) {
      console.error("locked-build: gave up waiting for the build lock");
      process.exit(2);
    }
    console.log("locked-build: another build is running, waiting");
    await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  let code = 1;
  try {
    code = run("npm run build");
    const sep = process.argv.indexOf("--");
    if (code === 0 && sep !== -1 && process.argv.length > sep + 1) {
      code = run(process.argv.slice(sep + 1).join(" "));
    }
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
  process.exit(code);
})();
