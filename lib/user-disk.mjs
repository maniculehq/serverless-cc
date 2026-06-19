// user-disk.mjs — provisions ONE Archil disk per user.
//
// Each signed-in user gets their own Archil disk (instead of everyone sharing the
// single ARCHIL_DISK). The disk name is a deterministic hash of the Better Auth
// user id, so we never need to persist a userId->diskId mapping: recompute the
// name and let Archil's createDisk (idempotent by name) hand back the disk.
//
// Object ops (getObject/putObject/...) authenticate with the account ARCHIL_API_KEY
// against the S3 host, so a freshly-created disk is usable immediately — there is
// no per-disk mount token to manage (the one createDisk returns is discarded).
//
// Provisioning runs on the MAIN thread (in app/api/agent/route.ts), before the
// agent worker spawns, so failures map to clean pre-stream HTTP responses. The
// resolved disk id is then handed to the worker via CC_DISK_ID (see agent-worker).
import crypto from "node:crypto";

const DISK_PREFIX = "cc-u-";
// First request for a brand-new user may see status "creating"; poll until ready.
const READY_TIMEOUT_MS = Number(process.env.CC_DISK_READY_TIMEOUT_MS || 30000);
const POLL_INTERVAL_MS = Number(process.env.CC_DISK_POLL_MS || 1000);

// Per-warm-instance cache: coalesces concurrent first-requests for the same user
// onto ONE create+poll. Stores the PROMISE (not the resolved id) so callers that
// arrive mid-provision await the same work. Evicted on rejection so a transient
// failure isn't pinned (mirrors the _runner = null pattern in route.ts).
const inflight = new Map(); // userId -> Promise<diskId>

// Disk took too long to leave "creating" — the route maps this to 503 + Retry-After.
export class DiskNotReadyError extends Error {
  constructor(diskId, status) {
    super(`disk ${diskId} not ready (status=${status})`);
    this.name = "DiskNotReadyError";
    this.diskId = diskId;
    this.status = status;
    this.retryAfter = 5;
  }
}

// Provisioning failed in a way the client can't fix by retrying — the route maps
// this to its httpStatus.
export class DiskProvisionError extends Error {
  constructor(message, httpStatus = 502) {
    super(message);
    this.name = "DiskProvisionError";
    this.httpStatus = httpStatus;
  }
}

// Deterministic, opaque, charset-safe disk name. We hash rather than embed the raw
// id so it stays within Archil's "alphanumeric, dashes, underscores" rule even if
// the id generator is ever customized, and so raw user ids don't leak into Archil
// dashboards/billing. 16 hex chars = 64 bits — collision-free for this scale.
export function diskNameForUser(userId) {
  const h = crypto.createHash("sha256").update(String(userId)).digest("hex");
  return DISK_PREFIX + h.slice(0, 16);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadArchil() {
  // KEEP THIS A STRING LITERAL — Next's file tracer only follows literal import
  // specifiers, and `disk` is in serverExternalPackages (see fs-backend.mjs:27-32).
  const archil = await import("disk");
  archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION });
  return archil;
}

async function waitUntilAvailable(archil, diskId, deadline) {
  let disk = await archil.getDisk(diskId);
  while (disk.status === "creating") {
    if (Date.now() >= deadline) throw new DiskNotReadyError(diskId, disk.status);
    await sleep(POLL_INTERVAL_MS);
    disk = await archil.getDisk(diskId);
  }
  if (disk.status !== "available") {
    throw new DiskProvisionError(`disk ${diskId} unusable (status=${disk.status})`, 500);
  }
  return disk.id;
}

async function provision(userId) {
  const name = diskNameForUser(userId);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let archil;
  try {
    archil = await loadArchil();
    // Idempotent by name: 200 if it already exists with matching config, 201 if
    // created. Omit `mounts` -> Archil-managed storage. The returned one-time mount
    // token is not needed (object ops use the account key), so we ignore it.
    const { disk } = await archil.createDisk({ name });
    if (disk.status === "available") return disk.id;
    return await waitUntilAvailable(archil, disk.id, deadline);
  } catch (e) {
    if (e instanceof DiskNotReadyError || e instanceof DiskProvisionError) throw e;
    if (e?.status === 403) throw new DiskProvisionError("Archil region not enabled for this account", 403);
    if (e?.status === 409) throw new DiskProvisionError(`disk name ${name} exists with conflicting config`, 409);
    throw new DiskProvisionError(e?.message || "disk provisioning failed", 502);
  }
}

// Resolve the user's disk id, provisioning it if needed. Returns null in in-memory
// mode (no ARCHIL_API_KEY) so callers fall through to the InMemoryFs backend.
export async function getUserDiskId(userId) {
  if (!process.env.ARCHIL_API_KEY) return null;
  if (!userId) throw new DiskProvisionError("getUserDiskId requires a userId", 500);

  let p = inflight.get(userId);
  if (!p) {
    p = provision(userId).catch((e) => {
      inflight.delete(userId); // don't pin a rejected promise
      throw e;
    });
    inflight.set(userId, p);
  }
  return p;
}

// Best-effort cleanup when a user is deleted (called from the Better Auth hook).
// Never throws — a failed delete just leaves a disk for the reconciler to prune.
export async function deleteUserDisk(userId) {
  if (!process.env.ARCHIL_API_KEY) return;
  inflight.delete(userId);
  const archil = await loadArchil();
  const [disk] = await archil.listDisks({ name: diskNameForUser(userId) });
  if (disk) await disk.delete();
}
