// fs-backend.mjs — one just-bash instance that ALL agent tools share.
//
// Backend is pluggable:
//   - ARCHIL_API_KEY set -> DiskFs over a real Archil disk (persistent, remote,
//     serverless-friendly) via the `disk` SDK's HTTPS object ops. No native
//     dependency (the @archildata/native mount client is unusable — its rustls
//     build panics on TLS init), and no in-memory limits.
//   - otherwise          -> just-bash InMemoryFs (local dev / tests, no creds).
//
// Either way the agent's shell + file tools operate on this single Bash/fs, so
// everything stays coherent.
import { Bash, InMemoryFs } from "just-bash";
import { DiskFs } from "./disk-fs.mjs";

export const WORKSPACE = process.env.CC_WORKSPACE || "/workspace";

let _bash = null;
let _disk = null;

export function usingArchil() { return !!process.env.ARCHIL_API_KEY; }
export function backendLabel() {
  if (!usingArchil()) return "just-bash InMemoryFs";
  // CC_DISK_ID is the per-user disk bound by the worker; ARCHIL_DISK is the
  // shared-disk fallback (local/tests/legacy).
  return `Archil disk via disk SDK (${process.env.CC_DISK_ID || process.env.ARCHIL_DISK})`;
}

const baseEnv = { HOME: WORKSPACE, PWD: WORKSPACE, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8" };

// mkdir the workspace, tolerating the brief window after a per-user disk turns
// "available" but before its fs handler accepts writes. ENOENT-style "already
// exists" races are swallowed by the caller's intent (a dir we want present).
async function mkdirWithRetry(fs, dir, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try { await fs.mkdir(dir); return; }
    catch (e) {
      if (i === attempts - 1) return; // best-effort: may already exist
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

async function buildDisk() {
  // KEEP THIS A STRING LITERAL. Next's file tracer only follows literal import
  // specifiers; `disk` is in serverExternalPackages (not bundled), so a computed
  // specifier here would silently drop disk + fast-xml-parser + openapi-fetch
  // from the deployment and the first Archil request would ERR_MODULE_NOT_FOUND.
  const archil = await import("disk");
  archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
  // CC_DISK_ID (the per-user disk, resolved + set by the worker) takes precedence;
  // otherwise fall back to the shared ARCHIL_DISK by name (local/tests/legacy).
  const id = process.env.CC_DISK_ID;
  let disk;
  if (id) {
    disk = await archil.getDisk(id);
  } else {
    const want = (process.env.ARCHIL_DISK || "").split("/").pop();
    const disks = await archil.listDisks();
    disk = disks.find((d) => d.name === want) || disks.find((d) => (d.name || "").endsWith(want)) || disks[0];
    if (!disk) throw new Error(`No Archil disk found matching "${want}"`);
  }
  _disk = disk;
  const fs = new DiskFs(disk);
  // First write to a just-turned-"available" disk can briefly 5xx while its
  // filesystem handler finishes coming up; retry the workspace mkdir a few times.
  await mkdirWithRetry(fs, WORKSPACE);
  return new Bash({ fs, cwd: WORKSPACE, env: baseEnv, defenseInDepth: false });
}

function buildInMemory() {
  return new Bash({
    fs: new InMemoryFs(),
    cwd: WORKSPACE,
    files: { [`${WORKSPACE}/.keep`]: "" },
    env: baseEnv,
    defenseInDepth: false,
  });
}

export async function getBash() {
  if (_bash) return _bash;
  _bash = usingArchil() ? await buildDisk() : buildInMemory();
  return _bash;
}

// Archil writes via `disk` object ops are direct (no checkout/checkin needed),
// so this is a straight pass-through. Kept so the tool code stays backend-agnostic.
export async function withWriteDelegation(_bash, _dir, fn) { return fn(); }

export function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }
export async function shutdown() { /* disk SDK is stateless HTTPS; nothing to close */ }
