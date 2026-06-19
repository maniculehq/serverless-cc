// fetch-cli.mjs — fetch + extract + patch the Claude Code bundle (bin/cli.js) at
// BUILD time. bin/cli.js is never committed (see .gitignore); only the pinned
// version in bin/cli.js.version is tracked.
//
// This reads that pinned version, downloads the matching standalone binary from
// npm (@anthropic-ai/claude-code-linux-x64 — the carved cli.js runs on any stock
// Bun regardless of which platform binary it came from), carves the readable
// cli.js out of it (same content-scan as scripts/extract.py, ported to JS so the
// build needs no Python), and re-applies the workspace tool-rename shim
// (scripts/patch-cli.mjs).
//
// Idempotent: skips when bin/cli.js is already built from the pinned version
// (tracked via the gitignored bin/.cli.js.built marker). Force with FORCE_FETCH_CLI=1.
//
//   bun scripts/fetch-cli.mjs            # use the version in bin/cli.js.version
//   bun scripts/fetch-cli.mjs 2.1.183    # override the version (used by CI)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BIN = path.join(ROOT, "bin");
const CLI = path.join(BIN, "cli.js");
const VERSION_FILE = path.join(BIN, "cli.js.version");
const BUILT_MARKER = path.join(BIN, ".cli.js.built");
// Platform binary package. The carved cli.js is byte-for-byte the same readable
// CommonJS source on every platform, so linux-x64 is fine everywhere.
const PKG = "@anthropic-ai/claude-code-linux-x64";
const REGISTRY = (process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");

const version = (process.argv[2] || fs.readFileSync(VERSION_FILE, "utf8")).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`bad version: "${version}"`);

// Fast path: already built from this exact version.
if (
  !process.env.FORCE_FETCH_CLI &&
  fs.existsSync(CLI) &&
  fs.existsSync(BUILT_MARKER) &&
  fs.readFileSync(BUILT_MARKER, "utf8").trim() === version
) {
  console.log(`[fetch-cli] bin/cli.js already built for ${version} — skipping`);
  process.exit(0);
}

console.log(`[fetch-cli] resolving ${PKG}@${version} …`);
const meta = await getJson(`${REGISTRY}/${PKG}/${version}`);
const tarballUrl = meta?.dist?.tarball;
if (!tarballUrl) throw new Error(`no dist.tarball for ${PKG}@${version}`);

console.log(`[fetch-cli] downloading ${tarballUrl}`);
const tgz = Buffer.from(await getBuffer(tarballUrl));

console.log(`[fetch-cli] decompressing (${tgz.length} bytes) …`);
const tar = zlib.gunzipSync(tgz, { maxOutputLength: 1024 * 1024 * 1024 });
const binary = extractTarEntry(tar, /(^|\/)claude$/);
if (!binary) throw new Error("package/claude not found in tarball");
console.log(`[fetch-cli] standalone binary: ${binary.length} bytes`);

const js = carveCli(binary);
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(CLI, js);
console.log(`[fetch-cli] carved bin/cli.js: ${js.length} bytes`);

// Re-apply the workspace tool-rename shim via the existing patch script.
execFileSync(process.execPath, [path.join(HERE, "patch-cli.mjs"), CLI], { stdio: "inherit" });

fs.writeFileSync(BUILT_MARKER, version + "\n");
console.log(`[fetch-cli] done — bin/cli.js is Claude Code ${version}`);

// --- helpers ---------------------------------------------------------------

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
async function getBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.arrayBuffer();
}

// Minimal ustar reader: 512-byte headers (name at 0..100, octal size at 124..136),
// file data padded up to the next 512-byte boundary. npm tarballs are plain
// ustar with short names, so this is sufficient. Returns the first entry whose
// name matches `re`.
function extractTarEntry(buf, re) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (!name) { off += 512; continue; } // zero block / padding
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8) || 0;
    const dataStart = off + 512;
    if (re.test(name)) return buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

// Port of scripts/extract.py: cli.js is the largest contiguous run of printable
// bytes (>= 500KB) that begins with "// @bun".
function carveCli(data) {
  const printable = (b) => (b >= 32 && b < 127) || b === 9 || b === 10 || b === 13;
  const regions = [];
  let start = -1;
  for (let i = 0; i < data.length; i++) {
    if (printable(data[i])) {
      if (start === -1) start = i;
    } else {
      if (start !== -1 && i - start >= 500_000) regions.push([start, i - start]);
      start = -1;
    }
  }
  if (start !== -1 && data.length - start >= 500_000) regions.push([start, data.length - start]);
  regions.sort((a, b) => b[1] - a[1]);
  const MARK = Buffer.from("// @bun");
  for (const [off, len] of regions) {
    const hp = data.subarray(off, off + 40).indexOf(MARK);
    if (hp !== -1) return data.subarray(off + hp, off + len);
  }
  throw new Error("cli.js bundle not found (no '// @bun' region) — bundle format changed");
}
