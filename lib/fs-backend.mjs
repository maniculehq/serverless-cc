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
  return usingArchil() ? `Archil disk via disk SDK (${process.env.ARCHIL_DISK})` : "just-bash InMemoryFs";
}

const baseEnv = { HOME: WORKSPACE, PWD: WORKSPACE, PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8" };

async function buildDisk() {
  const archil = await import("disk");
  archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
  const want = (process.env.ARCHIL_DISK || "").split("/").pop();
  const disks = await archil.listDisks();
  const disk = disks.find((d) => d.name === want) || disks.find((d) => (d.name || "").endsWith(want)) || disks[0];
  if (!disk) throw new Error(`No Archil disk found matching "${want}"`);
  _disk = disk;
  const fs = new DiskFs(disk);
  try { await fs.mkdir(WORKSPACE); } catch { /* may exist */ }
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
