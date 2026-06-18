// Next.js App Router route handler — runs on the BUN runtime on Vercel (set via
// `bunVersion` in vercel.json; do NOT add `export const runtime = "edge"`).
//
// Each POST runs in its OWN worker thread (lib/agent-worker.mjs, spawned by
// lib/agent-runner.mjs): under Vercel Fluid Compute one warm instance serves
// many concurrent invocations, so per-request isolation can't rely on
// module-level singletons. The worker gives each request its own JS VM + a
// per-request workspace prefix, and lets us hard-cancel a run (client disconnect
// or the maxDuration deadline) by killing the cli.js child from inside the worker
// — terminating the worker alone would orphan it.
//
// BUNDLER NOTE: the runner uses `new Worker()`, `process.cwd()` and `fs`, which
// Turbopack reacts to by creating a worker chunk and conservatively tracing the
// WHOLE project (it tries to parse LICENSE/eslint.config as modules and fails).
// So the runner is NOT bundled — it's loaded from disk at runtime (shipped via
// outputFileTracingIncludes "./lib/**"). The only static import here is a
// side-effect import of mcp-tools.mjs, purely to anchor the file tracer onto the
// worker's node_modules deps (Agent SDK / just-bash / disk), since the tracer
// can't follow the runtime path to the runner/worker.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { auth } from "@/lib/auth";
import "../../../lib/mcp-tools.mjs"; // tracing anchor only (SDK / just-bash / disk)

export const runtime = "nodejs"; // becomes Bun on Vercel via vercel.json bunVersion
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Load the un-bundled runner from disk once. turbopackIgnore keeps the bundler
// from following it (the static value is opaque to Turbopack anyway).
const RUNNER = pathToFileURL(path.join(process.cwd(), "lib", "agent-runner.mjs")).href;
let _runner: Promise<typeof import("../../../lib/agent-runner.mjs")> | null = null;
function runner() {
  if (!_runner) {
    // Don't cache a REJECTED promise — otherwise a transient module-eval failure
    // would brick every GET/POST on this warm instance with a permanent 500.
    _runner = import(/* turbopackIgnore: true */ RUNNER).catch((e) => {
      _runner = null; // let the next request re-attempt the import
      throw e;
    });
  }
  return _runner;
}

// This is a private, single-tenant app: every endpoint requires a valid,
// DB-validated GitHub session. Returns 401 JSON (not an HTML redirect) so the
// client `fetch` callers handle it cleanly.
async function unauthorized(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) return null;
  return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const denied = await unauthorized(request);
  if (denied) return denied;
  try {
    const { ensureBunOnPath, diag } = await runner();
    ensureBunOnPath();
    return Response.json({
      ok: true,
      service: "cc-archil",
      backend: process.env.ARCHIL_API_KEY ? "archil" : "in-memory",
      anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN),
      isolation: "worker-per-request",
      runner: RUNNER,
      ...diag(),
    });
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), runner: RUNNER },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await unauthorized(request);
  if (denied) return denied;

  let body: { prompt?: string; session?: string } = {};
  try { body = await request.json(); } catch {}
  const prompt = body?.prompt;
  if (!prompt || !prompt.trim()) {
    return Response.json({ ok: false, error: "missing 'prompt'" }, { status: 400 });
  }
  const session = body?.session;

  let runAgentWorker: typeof import("../../../lib/agent-runner.mjs").runAgentWorker;
  let atCapacity: typeof import("../../../lib/agent-runner.mjs").atCapacity;
  try {
    ({ runAgentWorker, atCapacity } = await runner());
  } catch (e: unknown) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e), runner: RUNNER },
      { status: 500 },
    );
  }

  // Shed load before committing a worker + cli.js child to a shared Fluid instance.
  if (atCapacity()) {
    return Response.json(
      { ok: false, error: "server at capacity, retry shortly" },
      { status: 429, headers: { "retry-after": "5" } },
    );
  }

  const encoder = new TextEncoder();
  let cancelRun: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n")); } catch {}
      };

      const { done, cancel } = runAgentWorker({ prompt, session, onEvent: send });
      cancelRun = cancel;

      // Cancel on client disconnect or just before the function deadline, so the
      // cli.js child is torn down and doesn't hold resources on the shared
      // Fluid instance.
      const onAbort = () => cancel();
      request.signal.addEventListener("abort", onAbort);
      // addEventListener("abort") does NOT fire for an already-aborted signal, so
      // catch a client that disconnected during the pre-stream awaits (json/import).
      if (request.signal.aborted) cancel();
      const deadline = setTimeout(cancel, (maxDuration - 15) * 1000);

      done.finally(() => {
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", onAbort);
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      try { cancelRun?.(); } catch {}
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
