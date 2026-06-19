// agent-runner.mjs — main-thread glue that runs one agent request in its own
// worker thread (lib/agent-worker.mjs) and streams its events back to a caller.
//
// Used by both the Next route handler (app/api/agent/route.ts) and the local
// concurrency test (scripts/test-workers.mjs) so the spawn + cancel + cleanup
// logic lives in exactly one place.
//
// FILE TRACING: the worker is referenced only by a runtime-computed path string
// (process.cwd()+lib/agent-worker.mjs) so the Next/Turbopack bundler never sees
// it — it ships via outputFileTracingIncludes ("./lib/**"). The worker's
// node_modules deps (SDK / just-bash / disk) are NOT reachable from that runtime
// path either, so we statically `import` from mcp-tools.mjs HERE (this file IS in
// the route's static import graph) to anchor the file tracer onto those package
// trees. TOOL_NAMES is then handed to the worker via workerData.

import { Worker } from "node:worker_threads";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { TOOL_NAMES } from "./mcp-tools.mjs"; // anchors SDK/just-bash/disk tracing

const WORKER = process.env.CC_WORKER || path.join(process.cwd(), "lib", "agent-worker.mjs");
const CLI = process.env.CC_CLI || path.join(process.cwd(), "bin", "cli.js");
const WORKSPACE_BASE = process.env.CC_WORKSPACE_BASE || "/workspace";

// Bound in-process concurrency: each run holds a Worker thread + a cli.js child
// for up to maxDuration, and Fluid multiplexes many invocations onto one warm
// instance, so an unbounded burst could OOM the instance and take down every
// co-located request. Pairs with Vercel's platform-level concurrency limit.
const MAX_CONCURRENCY = Number(process.env.CC_MAX_CONCURRENCY || 10);
let active = 0;
export function atCapacity() { return active >= MAX_CONCURRENCY; }
export function activeRuns() { return active; }

const bunVersion = () => process.versions.bun;

// The Agent SDK spawns the runtime by name ("bun"), which isn't on PATH inside
// the Vercel function. We run UNDER bun (process.execPath), so expose it as
// /tmp/bin/bun and prepend that to PATH — the worker inherits this patched PATH
// via its `env` option, and passes it through to the spawned child.
let BUN_LINK = "uninitialized";
export function ensureBunOnPath() {
  try {
    if (!bunVersion()) return (BUN_LINK = "not-bun:" + process.execPath);
    const binDir = "/tmp/bin";
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, "bun");
    try { fs.unlinkSync(link); } catch { /* not present */ }
    fs.symlinkSync(process.execPath, link);
    const parts = (process.env.PATH || "").split(":");
    if (!parts.includes(binDir)) process.env.PATH = binDir + ":" + (process.env.PATH || "");
    return (BUN_LINK = link + " -> " + process.execPath);
  } catch (e) {
    return (BUN_LINK = "ERR:" + (e instanceof Error ? e.message : String(e)));
  }
}

export function diag() {
  return {
    cliExists: fs.existsSync(CLI),
    workerExists: fs.existsSync(WORKER),
    runtime: bunVersion() ? "bun " + bunVersion() : "node " + process.versions.node,
    bunLink: BUN_LINK,
  };
}

// Run one request in a fresh worker.
//   { prompt, session?, diskId?, onEvent } -> { done: Promise<{ok,reqId}>, cancel(), reqId, workspaceRoot }
// onEvent is called with each worker event ({t:...}); the terminal {__exit} and
// {t:"result"} are surfaced as the `done` promise resolving.
export function runAgentWorker({ prompt, session, diskId, onEvent }) {
  ensureBunOnPath();

  const reqId = crypto.randomUUID();
  // Workspace + persistence model:
  //  - diskId set (per-user disk): the disk IS the isolation boundary, so the
  //    workspace is a stable, PERSISTENT /workspace (an optional `session`
  //    namespaces a sub-workspace within the user's own disk). Never GC'd.
  //  - no diskId (shared-disk fallback: tests/local/legacy): keep the per-request
  //    prefix so concurrent runs don't collide, and GC it unless a session is given.
  let workspaceRoot;
  let ephemeral;
  if (diskId) {
    workspaceRoot = session ? `${WORKSPACE_BASE}/${session}` : WORKSPACE_BASE;
    ephemeral = false;
  } else {
    workspaceRoot = `${WORKSPACE_BASE}/${session || reqId}`;
    ephemeral = !session;
  }
  const home = `/tmp/cchome/${reqId}`;

  // turbopackIgnore: Turbopack otherwise treats `new Worker(...)` as a worker
  // chunk to bundle, mis-resolves the entry, and drags bin/cli.js into the build
  // (whose internal dynamic import() then trips the NFT whole-project tracer).
  // The worker entry is a real on-disk file we ship via outputFileTracingIncludes.
  const worker = new Worker(/* turbopackIgnore: true */ WORKER, {
    workerData: { reqId, prompt, cli: CLI, workspaceRoot, home, toolNames: TOOL_NAMES, diskId, ephemeral },
    env: { ...process.env }, // full inherit incl. patched PATH; worker re-scopes CC_WORKSPACE + CC_DISK_ID
  });
  active++; // released exactly once in finish()

  let finished = false;
  let settle;
  const done = new Promise((r) => { settle = r; });
  let backstop = null;

  const finish = (info) => {
    if (finished) return;
    finished = true;
    active--;
    if (backstop) { clearTimeout(backstop); backstop = null; }
    worker.terminate().catch(() => {}); // idle worker (child already gone) — safe
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {} // reclaim /tmp HOME
    settle(info);
  };

  // The worker's terminal {__exit} carries the run's success flag (it swallows its
  // own errors so worker.on("error") won't fire for SDK throws/aborts).
  worker.on("message", (m) => {
    if (m && m.__exit) { finish({ ok: m.ok !== false, reqId, aborted: !!m.aborted }); return; }
    try { onEvent(m); } catch { /* consumer gone */ }
  });
  worker.on("error", (e) => {
    try { onEvent({ t: "error", error: e instanceof Error ? e.message : String(e) }); } catch {}
    finish({ ok: false, reqId });
  });
  worker.on("exit", () => finish({ ok: true, reqId }));

  // Cancel: tell the worker to abort (it kills the child from the inside), then
  // force-terminate as a backstop AFTER the SDK's ~7s SIGTERM→SIGKILL escalation,
  // so we never terminate-then-orphan. Idempotent + guarded so a late cancel
  // (stream-cancel callback, abort-listener window) can't arm an orphan timer.
  const cancel = () => {
    if (finished) return;
    try { worker.postMessage({ __cmd: "abort" }); } catch {}
    if (!backstop) {
      backstop = setTimeout(() => worker.terminate().catch(() => {}), 9000);
      backstop.unref?.(); // never pin the event loop on the backstop alone
    }
  };

  return { done, cancel, reqId, workspaceRoot };
}
